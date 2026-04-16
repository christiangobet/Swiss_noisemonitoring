#!/usr/bin/env python3
"""
TramWatch — Interior Sensor Daemon
Reads USB microphone via PyAudio, computes RMS dB(A), POSTs readings to TramWatch.

# ============================================================
# SYSTEMD SERVICE FILE — save as /etc/systemd/system/tramwatch-interior.service
# ============================================================
# [Unit]
# Description=TramWatch Interior Microphone Daemon
# After=sound.target network-online.target
# Wants=network-online.target
#
# [Service]
# Type=simple
# User=pi
# EnvironmentFile=/etc/tramwatch/interior.env
# ExecStart=/usr/bin/python3 /home/pi/tramwatch/interior_daemon.py
# Restart=always
# RestartSec=5
# StandardOutput=journal
# StandardError=journal
#
# [Install]
# WantedBy=multi-user.target
# ============================================================
#
# INSTALL:
#   sudo apt-get install -y portaudio19-dev python3-pyaudio
#   pip3 install pyaudio requests
#   # List audio devices: python3 -c "import pyaudio; p = pyaudio.PyAudio(); [print(i, p.get_device_info_by_index(i)['name']) for i in range(p.get_device_count())]"
#
# ENVIRONMENT VARIABLES (set in /etc/tramwatch/interior.env):
#   TRAMWATCH_URL=https://your-app.vercel.app
#   TRAMWATCH_SECRET=your-ingest-secret
#   SOFTWARE_OFFSET=0.0       # Pre-calibration dB offset added to raw reading
#   AUDIO_DEVICE_INDEX=       # Leave blank to use default; set to index from list above
#   AUDIO_SAMPLE_RATE=44100
#   AUDIO_CHUNK_SIZE=4096
"""

import json
import logging
import math
import os
import signal
import struct
import sys
import time
from collections import deque
from datetime import datetime, timezone

import pyaudio
import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
TRAMWATCH_URL    = os.environ.get("TRAMWATCH_URL", "").rstrip("/")
TRAMWATCH_SECRET = os.environ.get("TRAMWATCH_SECRET", "")
SOFTWARE_OFFSET  = float(os.environ.get("SOFTWARE_OFFSET", "0.0"))
FLUSH_INTERVAL   = int(os.environ.get("FLUSH_INTERVAL", "10"))
HEALTH_FILE      = os.environ.get("HEALTH_FILE", "/tmp/tramwatch_interior.json")
MAX_BUFFER       = 60

AUDIO_DEVICE_INDEX = os.environ.get("AUDIO_DEVICE_INDEX")
AUDIO_DEVICE_INDEX = int(AUDIO_DEVICE_INDEX) if AUDIO_DEVICE_INDEX else None
SAMPLE_RATE  = int(os.environ.get("AUDIO_SAMPLE_RATE", "44100"))
CHUNK_SIZE   = int(os.environ.get("AUDIO_CHUNK_SIZE", "4096"))
CHANNELS     = 1
FORMAT       = pyaudio.paInt16
BITS         = 16
REF          = 1.0 / 32768.0  # reference amplitude for 16-bit signed PCM

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [interior] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("interior")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
running = True


def handle_signal(signum, frame):
    global running
    log.info("Received signal %d, shutting down", signum)
    running = False


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


# ---------------------------------------------------------------------------
# RMS → dB conversion
# ---------------------------------------------------------------------------
def pcm_to_db(raw_bytes: bytes) -> float | None:
    """
    Convert 16-bit signed PCM bytes to dB relative to full-scale.
    Formula: dB = 20 * log10(rms / ref), where ref = 1/32768.
    Returns None if signal is silent (all zeros).
    """
    n = len(raw_bytes) // 2
    if n == 0:
        return None
    samples = struct.unpack(f"<{n}h", raw_bytes)
    sum_sq = sum(s * s for s in samples)
    if sum_sq == 0:
        return None
    rms = math.sqrt(sum_sq / n)
    db = 20.0 * math.log10(rms * REF)  # negative value, relative to 0 dBFS
    # Convert to approximate SPL by adding offset
    # The SOFTWARE_OFFSET calibrates this to a physical dB(A) value.
    # A typical USB mic at conversational levels produces ~-30 to -10 dBFS.
    # The app calibration wizard refines this offset empirically.
    return db + SOFTWARE_OFFSET


# ---------------------------------------------------------------------------
# Flush to API
# ---------------------------------------------------------------------------
def flush_buffer():
    if not buffer:
        return
    if not TRAMWATCH_URL or not TRAMWATCH_SECRET:
        log.warning("TRAMWATCH_URL or TRAMWATCH_SECRET not set — skipping flush")
        return

    readings = list(buffer)
    buffer.clear()

    payload = {"source": "interior", "readings": readings}
    url = f"{TRAMWATCH_URL}/api/ingest"

    for attempt in range(3):
        try:
            resp = requests.post(
                url,
                json=payload,
                headers={"x-api-key": TRAMWATCH_SECRET},
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                log.info(
                    "Flushed %d readings → inserted=%d offset_applied=%.2f",
                    len(readings),
                    data.get("inserted", 0),
                    data.get("offset_applied", 0.0),
                )
                return
            else:
                log.warning("API returned %d: %s", resp.status_code, resp.text[:120])
        except requests.RequestException as e:
            log.warning("Flush attempt %d failed: %s", attempt + 1, e)
        time.sleep(2 ** attempt)

    log.error("All flush attempts failed — %d readings dropped", len(readings))


def write_health(db_value: float | None):
    data = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "db_raw": db_value,
        "source": "interior",
        "software_offset": SOFTWARE_OFFSET,
        "buffer_size": len(buffer),
    }
    try:
        with open(HEALTH_FILE, "w") as f:
            json.dump(data, f)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Audio stream
# ---------------------------------------------------------------------------
def open_stream(pa: pyaudio.PyAudio) -> pyaudio.Stream | None:
    """Try to open the audio stream. Returns stream or None."""
    kwargs: dict = {
        "format": FORMAT,
        "channels": CHANNELS,
        "rate": SAMPLE_RATE,
        "input": True,
        "frames_per_buffer": CHUNK_SIZE,
    }
    if AUDIO_DEVICE_INDEX is not None:
        kwargs["input_device_index"] = AUDIO_DEVICE_INDEX
    try:
        stream = pa.open(**kwargs)
        device_info = pa.get_device_info_by_index(
            AUDIO_DEVICE_INDEX if AUDIO_DEVICE_INDEX is not None else pa.get_default_input_device_info()["index"]
        )
        log.info("Audio stream opened: %s @ %d Hz", device_info["name"], SAMPLE_RATE)
        return stream
    except OSError as e:
        log.warning("Cannot open audio stream: %s", e)
        return None


def read_one_second(stream: pyaudio.Stream) -> float | None:
    """Read ~1 second of audio and return dB value."""
    chunks_per_second = max(1, int(SAMPLE_RATE / CHUNK_SIZE))
    frames = b""
    try:
        for _ in range(chunks_per_second):
            data = stream.read(CHUNK_SIZE, exception_on_overflow=False)
            frames += data
    except OSError as e:
        log.warning("Audio read error: %s", e)
        return None
    return pcm_to_db(frames)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    log.info("TramWatch interior daemon starting (SOFTWARE_OFFSET=%.1f dB)", SOFTWARE_OFFSET)
    if not TRAMWATCH_URL:
        log.error("TRAMWATCH_URL is not set")
        sys.exit(1)

    pa = pyaudio.PyAudio()
    stream = None
    last_flush = time.monotonic()

    try:
        while running:
            # (Re)connect audio stream if needed
            if stream is None:
                stream = open_stream(pa)
                if stream is None:
                    log.info("Retrying audio open in 5s…")
                    time.sleep(5)
                    continue

            db_val = read_one_second(stream)

            if db_val is None:
                log.warning("Bad audio read — reconnecting")
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
                stream = None
                write_health(None)
                continue

            ts = datetime.now(timezone.utc).isoformat()
            buffer.append({"ts": ts, "db_raw": db_val})
            write_health(db_val)
            log.debug("%.1f dBFS+offset @ %s", db_val, ts)

            now = time.monotonic()
            if now - last_flush >= FLUSH_INTERVAL:
                flush_buffer()
                last_flush = now

    finally:
        flush_buffer()
        if stream:
            try:
                stream.stop_stream()
                stream.close()
            except Exception:
                pass
        pa.terminate()
        log.info("Interior daemon stopped")


if __name__ == "__main__":
    main()
