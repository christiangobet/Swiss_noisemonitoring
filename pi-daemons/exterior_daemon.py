#!/usr/bin/env python3
"""
TramWatch — Exterior Sensor Daemon
Reads Benetech GM1356 USB SPL meter via hidapi and POSTs readings to TramWatch.

# ============================================================
# SYSTEMD SERVICE FILE — save as /etc/systemd/system/tramwatch-exterior.service
# ============================================================
# [Unit]
# Description=TramWatch Exterior SPL Daemon
# After=network-online.target
# Wants=network-online.target
#
# [Service]
# Type=simple
# User=pi
# EnvironmentFile=/etc/tramwatch/exterior.env
# ExecStart=/usr/bin/python3 /home/pi/tramwatch/exterior_daemon.py
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
#   pip3 install hidapi requests
#   sudo systemctl daemon-reload
#   sudo systemctl enable tramwatch-exterior
#   sudo systemctl start tramwatch-exterior
#
# UDEV RULE (no sudo needed for USB access):
#   Create /etc/udev/rules.d/99-gm1356.rules:
#     SUBSYSTEM=="hidraw", ATTRS{idVendor}=="64bd", ATTRS{idProduct}=="74e3", MODE="0666"
#   Then: sudo udevadm control --reload-rules && sudo udevadm trigger
#
# ENVIRONMENT VARIABLES (set in /etc/tramwatch/exterior.env):
#   TRAMWATCH_URL=https://your-app.vercel.app
#   TRAMWATCH_SECRET=your-ingest-secret
"""

import hid
import json
import logging
import os
import signal
import sys
import time
from collections import deque
from datetime import datetime, timezone

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
VENDOR_ID  = 0x64BD
PRODUCT_ID = 0x74E3
CMD_BUFFER = [0x00, 0xB3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

TRAMWATCH_URL    = os.environ.get("TRAMWATCH_URL", "").rstrip("/")
TRAMWATCH_SECRET = os.environ.get("TRAMWATCH_SECRET", "")
FLUSH_INTERVAL   = int(os.environ.get("FLUSH_INTERVAL", "10"))   # seconds between POSTs
SAMPLE_INTERVAL  = float(os.environ.get("SAMPLE_INTERVAL", "1")) # seconds between reads
HEALTH_FILE      = os.environ.get("HEALTH_FILE", "/tmp/tramwatch_exterior.json")
MAX_BUFFER       = 60

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [exterior] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("exterior")

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
# GM1356 reader
# ---------------------------------------------------------------------------
def decode_db(data: list[int]) -> float:
    """Convert raw GM1356 HID report bytes to dB(A)."""
    return (data[1] * 256 + data[2]) * 0.1


def open_device() -> hid.device | None:
    """Try to open the GM1356. Returns device or None."""
    try:
        dev = hid.device()
        dev.open(VENDOR_ID, PRODUCT_ID)
        dev.set_nonblocking(False)
        log.info("GM1356 opened (vendor=%04x product=%04x)", VENDOR_ID, PRODUCT_ID)
        return dev
    except OSError as e:
        log.warning("Cannot open GM1356: %s", e)
        return None


def read_once(dev: hid.device) -> float | None:
    """Send command, read response, return dB value or None on error."""
    try:
        dev.write(CMD_BUFFER)
        data = dev.read(8, timeout_ms=2000)
        if not data or len(data) < 3:
            return None
        return decode_db(data)
    except OSError as e:
        log.warning("Read error: %s", e)
        return None


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

    payload = {"source": "exterior", "readings": readings}
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
                log.info("Flushed %d readings → inserted=%d", len(readings), data.get("inserted", "?"))
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
        "source": "exterior",
        "buffer_size": len(buffer),
    }
    try:
        with open(HEALTH_FILE, "w") as f:
            json.dump(data, f)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
def main():
    log.info("TramWatch exterior daemon starting")
    if not TRAMWATCH_URL:
        log.error("TRAMWATCH_URL is not set")
        sys.exit(1)

    dev = None
    last_flush = time.monotonic()

    while running:
        # Reconnect if needed
        if dev is None:
            dev = open_device()
            if dev is None:
                log.info("Retrying USB open in 5s…")
                time.sleep(5)
                continue

        # Read one sample
        db_val = read_once(dev)

        if db_val is None:
            log.warning("Bad read — closing device for reconnect")
            try:
                dev.close()
            except Exception:
                pass
            dev = None
            write_health(None)
            time.sleep(1)
            continue

        ts = datetime.now(timezone.utc).isoformat()
        buffer.append({"ts": ts, "db_raw": db_val})
        write_health(db_val)
        log.debug("%.1f dB(A) @ %s", db_val, ts)

        # Flush on interval
        now = time.monotonic()
        if now - last_flush >= FLUSH_INTERVAL:
            flush_buffer()
            last_flush = now

        # Sleep until next sample
        time.sleep(SAMPLE_INTERVAL)

    # Final flush on shutdown
    flush_buffer()
    if dev:
        try:
            dev.close()
        except Exception:
            pass
    log.info("Exterior daemon stopped")


if __name__ == "__main__":
    main()
