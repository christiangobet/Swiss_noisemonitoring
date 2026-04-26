#!/usr/bin/env python3
"""
TramWatch — Microphone Daemon
Records ambient noise via USB/built-in mic and streams 1-second Leq readings
to TramWatch as a named remote source. No tram detection — that is done later
when reviewing the dataset in the web app.

SYSTEMD SERVICE — /etc/systemd/system/tramwatch-mic.service
  [Unit]
  Description=TramWatch Microphone Daemon
  After=sound.target network-online.target
  Wants=network-online.target
  [Service]
  Type=simple
  User=pi
  EnvironmentFile=/etc/tramwatch/mic.env
  ExecStart=/usr/bin/python3 /home/pi/tramwatch/interior_daemon.py
  Restart=always
  RestartSec=5
  StandardOutput=journal
  StandardError=journal
  [Install]
  WantedBy=multi-user.target

INSTALL:
  sudo apt-get install -y portaudio19-dev python3-pyaudio
  pip3 install pyaudio requests

LIST AUDIO DEVICES:
  python3 -c "
  import pyaudio; p = pyaudio.PyAudio()
  for i in range(p.get_device_count()):
      d = p.get_device_info_by_index(i)
      if d['maxInputChannels'] > 0: print(i, d['name'])
  p.terminate()"

ENVIRONMENT VARIABLES (/etc/tramwatch/mic.env):
  TRAMWATCH_URL=https://your-app.vercel.app
  SOURCE_NAME=roof-pi           # shown as source name in the live chart
  SOFTWARE_OFFSET=100.0         # coarse dBFS→SPL estimate; refine via calibration wizard
  AUDIO_DEVICE_INDEX=           # leave blank for system default
  AUDIO_SAMPLE_RATE=44100
  AUDIO_CHUNK_SIZE=4096
  FLUSH_INTERVAL=2              # seconds between POSTs (2s matches live chart poll)
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
TRAMWATCH_URL   = os.environ.get("TRAMWATCH_URL", "").rstrip("/")
SOURCE_NAME     = (os.environ.get("SOURCE_NAME", "pi-mic").strip() or "pi-mic")[:32]
SOFTWARE_OFFSET = float(os.environ.get("SOFTWARE_OFFSET", "0.0"))
FLUSH_INTERVAL  = int(os.environ.get("FLUSH_INTERVAL", "2"))
HEALTH_FILE     = os.environ.get("HEALTH_FILE", "/tmp/tramwatch_mic.json")
MAX_BUFFER      = 60

AUDIO_DEVICE_INDEX = os.environ.get("AUDIO_DEVICE_INDEX")
AUDIO_DEVICE_INDEX = int(AUDIO_DEVICE_INDEX) if AUDIO_DEVICE_INDEX else None
SAMPLE_RATE = int(os.environ.get("AUDIO_SAMPLE_RATE", "44100"))
CHUNK_SIZE  = int(os.environ.get("AUDIO_CHUNK_SIZE", "4096"))
FORMAT      = pyaudio.paInt16
REF         = 1.0 / 32768.0   # reference for 16-bit signed PCM → dBFS

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format=f"%(asctime)s [{SOURCE_NAME}] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(SOURCE_NAME)

buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
running = True


def handle_signal(signum, frame):
    global running
    log.info("Received signal %d, shutting down", signum)
    running = False


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


# ---------------------------------------------------------------------------
# PCM → dB
# ---------------------------------------------------------------------------
def pcm_to_db(raw_bytes: bytes) -> float | None:
    n = len(raw_bytes) // 2
    if n == 0:
        return None
    samples = struct.unpack(f"<{n}h", raw_bytes)
    sum_sq = sum(s * s for s in samples)
    if sum_sq == 0:
        return None
    rms = math.sqrt(sum_sq / n)
    return 20.0 * math.log10(rms * REF) + SOFTWARE_OFFSET


# ---------------------------------------------------------------------------
# Flush to server (no API key — same endpoint as browser)
# ---------------------------------------------------------------------------
def flush_buffer():
    if not buffer:
        return
    if not TRAMWATCH_URL:
        log.warning("TRAMWATCH_URL not set — skipping flush")
        return

    readings = list(buffer)
    buffer.clear()

    payload = {"source": SOURCE_NAME, "readings": readings}
    url = f"{TRAMWATCH_URL}/api/browser-ingest"

    for attempt in range(3):
        try:
            resp = requests.post(url, json=payload, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                log.info(
                    "Flushed %d readings → inserted=%d offset_applied=%.2f",
                    len(readings),
                    data.get("inserted", 0),
                    data.get("offset_applied", 0.0),
                )
                return
            log.warning("API returned %d: %s", resp.status_code, resp.text[:120])
        except requests.RequestException as e:
            log.warning("Flush attempt %d failed: %s", attempt + 1, e)
        time.sleep(2 ** attempt)

    log.error("All flush attempts failed — %d readings dropped", len(readings))


def write_health(db_value: float | None):
    try:
        with open(HEALTH_FILE, "w") as f:
            json.dump({
                "ts": datetime.now(timezone.utc).isoformat(),
                "db_raw": db_value,
                "source": SOURCE_NAME,
                "software_offset": SOFTWARE_OFFSET,
                "buffer_size": len(buffer),
            }, f)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------
def open_stream(pa: pyaudio.PyAudio) -> pyaudio.Stream | None:
    kwargs: dict = {
        "format": FORMAT,
        "channels": 1,
        "rate": SAMPLE_RATE,
        "input": True,
        "frames_per_buffer": CHUNK_SIZE,
    }
    if AUDIO_DEVICE_INDEX is not None:
        kwargs["input_device_index"] = AUDIO_DEVICE_INDEX
    try:
        stream = pa.open(**kwargs)
        idx = AUDIO_DEVICE_INDEX if AUDIO_DEVICE_INDEX is not None \
              else pa.get_default_input_device_info()["index"]
        log.info("Audio opened: %s @ %d Hz", pa.get_device_info_by_index(idx)["name"], SAMPLE_RATE)
        return stream
    except OSError as e:
        log.warning("Cannot open audio stream: %s", e)
        return None


def read_one_second(stream: pyaudio.Stream) -> float | None:
    chunks = max(1, int(SAMPLE_RATE / CHUNK_SIZE))
    frames = b""
    try:
        for _ in range(chunks):
            frames += stream.read(CHUNK_SIZE, exception_on_overflow=False)
    except OSError as e:
        log.warning("Audio read error: %s", e)
        return None
    return pcm_to_db(frames)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log.info("Starting (source=%s SOFTWARE_OFFSET=%.1f FLUSH_INTERVAL=%ds)",
             SOURCE_NAME, SOFTWARE_OFFSET, FLUSH_INTERVAL)
    if not TRAMWATCH_URL:
        log.error("TRAMWATCH_URL is not set"); sys.exit(1)

    pa = pyaudio.PyAudio()
    stream = None
    last_flush = time.monotonic()

    try:
        while running:
            if stream is None:
                stream = open_stream(pa)
                if stream is None:
                    time.sleep(5); continue

            db_val = read_one_second(stream)

            if db_val is None:
                log.warning("Bad audio read — reconnecting")
                try: stream.stop_stream(); stream.close()
                except Exception: pass
                stream = None
                write_health(None)
                continue

            buffer.append({"ts": datetime.now(timezone.utc).isoformat(), "db_raw": db_val})
            write_health(db_val)
            log.debug("%.1f dB", db_val)

            if time.monotonic() - last_flush >= FLUSH_INTERVAL:
                flush_buffer()
                last_flush = time.monotonic()
    finally:
        flush_buffer()
        if stream:
            try: stream.stop_stream(); stream.close()
            except Exception: pass
        pa.terminate()
        log.info("Stopped")


if __name__ == "__main__":
    main()
