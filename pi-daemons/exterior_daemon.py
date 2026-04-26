#!/usr/bin/env python3
"""
TramWatch — GM1356 SPL Meter Daemon (Benetech USB HID)
Streams 1-second SPL readings from a Benetech GM1356 to TramWatch as a named
remote source. No tram detection — done later when reviewing the dataset.

SYSTEMD SERVICE — /etc/systemd/system/tramwatch-spl.service
  [Unit]
  Description=TramWatch GM1356 SPL Daemon
  After=network-online.target
  Wants=network-online.target
  [Service]
  Type=simple
  User=pi
  EnvironmentFile=/etc/tramwatch/spl.env
  ExecStart=/usr/bin/python3 /home/pi/tramwatch/exterior_daemon.py
  Restart=always
  RestartSec=5
  StandardOutput=journal
  StandardError=journal
  [Install]
  WantedBy=multi-user.target

INSTALL:
  sudo apt-get install -y libhidapi-dev
  pip3 install hidapi requests

UDEV RULE (no sudo for USB access):
  /etc/udev/rules.d/99-gm1356.rules:
    SUBSYSTEM=="hidraw", ATTRS{idVendor}=="64bd", ATTRS{idProduct}=="74e3", MODE="0666"
  sudo udevadm control --reload-rules && sudo udevadm trigger

ENVIRONMENT VARIABLES (/etc/tramwatch/spl.env):
  TRAMWATCH_URL=https://your-app.vercel.app
  SOURCE_NAME=spl-ext           # shown as source name in the live chart
  FLUSH_INTERVAL=2              # seconds between POSTs (2s matches live chart poll)
  SAMPLE_INTERVAL=1             # seconds between SPL meter reads
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

TRAMWATCH_URL  = os.environ.get("TRAMWATCH_URL", "").rstrip("/")
SOURCE_NAME    = (os.environ.get("SOURCE_NAME", "pi-spl").strip() or "pi-spl")[:32]
FLUSH_INTERVAL = int(os.environ.get("FLUSH_INTERVAL", "2"))
SAMPLE_INTERVAL = float(os.environ.get("SAMPLE_INTERVAL", "1"))
HEALTH_FILE    = os.environ.get("HEALTH_FILE", "/tmp/tramwatch_spl.json")
MAX_BUFFER     = 60

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
# GM1356
# ---------------------------------------------------------------------------
def decode_db(data: list[int]) -> float:
    return (data[1] * 256 + data[2]) * 0.1


def open_device() -> hid.device | None:
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
                "buffer_size": len(buffer),
            }, f)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    log.info("Starting (source=%s FLUSH_INTERVAL=%ds SAMPLE_INTERVAL=%.1fs)",
             SOURCE_NAME, FLUSH_INTERVAL, SAMPLE_INTERVAL)
    if not TRAMWATCH_URL:
        log.error("TRAMWATCH_URL is not set"); sys.exit(1)

    dev = None
    last_flush = time.monotonic()

    while running:
        if dev is None:
            dev = open_device()
            if dev is None:
                time.sleep(5); continue

        db_val = read_once(dev)

        if db_val is None:
            log.warning("Bad read — reconnecting")
            try: dev.close()
            except Exception: pass
            dev = None
            write_health(None)
            time.sleep(1)
            continue

        buffer.append({"ts": datetime.now(timezone.utc).isoformat(), "db_raw": db_val})
        write_health(db_val)
        log.debug("%.1f dB(A)", db_val)

        if time.monotonic() - last_flush >= FLUSH_INTERVAL:
            flush_buffer()
            last_flush = time.monotonic()

        time.sleep(SAMPLE_INTERVAL)

    flush_buffer()
    if dev:
        try: dev.close()
        except Exception: pass
    log.info("Stopped")


if __name__ == "__main__":
    main()
