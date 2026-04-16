# TramWatch Pi Daemons

Setup guide for both Raspberry Pi sensors.

## Hardware

| Pi | Sensor | Device |
|----|--------|--------|
| Pi #1 (Exterior) | Benetech GM1356 USB SPL meter | USB HID, vendor `0x64BD`, product `0x74E3` |
| Pi #2 (Interior) | Any USB microphone | PyAudio input |

---

## Prerequisites (both Pis)

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y python3-pip python3-dev git
pip3 install requests
```

---

## Pi #1 — Exterior (GM1356)

### 1. Install dependencies

```bash
sudo apt-get install -y libhidapi-dev
pip3 install hidapi requests
```

### 2. udev rule (allows USB access without sudo)

Create `/etc/udev/rules.d/99-gm1356.rules`:

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="64bd", ATTRS{idProduct}=="74e3", MODE="0666"
```

Apply:
```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Plug in the GM1356 and verify:
```bash
ls -la /dev/hidraw*
```

### 3. Environment variables

Create `/etc/tramwatch/exterior.env`:

```bash
TRAMWATCH_URL=https://your-app.vercel.app
TRAMWATCH_SECRET=your-ingest-secret-here
FLUSH_INTERVAL=10
SAMPLE_INTERVAL=1
```

### 4. Deploy script

```bash
sudo mkdir -p /home/pi/tramwatch
sudo cp exterior_daemon.py /home/pi/tramwatch/
```

### 5. Install as systemd service

```bash
sudo cp exterior_daemon.py /home/pi/tramwatch/exterior_daemon.py
cat > /tmp/tramwatch-exterior.service << 'EOF'
[Unit]
Description=TramWatch Exterior SPL Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
EnvironmentFile=/etc/tramwatch/exterior.env
ExecStart=/usr/bin/python3 /home/pi/tramwatch/exterior_daemon.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
sudo cp /tmp/tramwatch-exterior.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tramwatch-exterior
sudo systemctl start tramwatch-exterior
```

### 6. Verify

```bash
sudo systemctl status tramwatch-exterior
journalctl -u tramwatch-exterior -f
cat /tmp/tramwatch_exterior.json
```

---

## Pi #2 — Interior (USB Microphone)

### 1. Install dependencies

```bash
sudo apt-get install -y portaudio19-dev python3-pyaudio
pip3 install pyaudio requests
```

### 2. Find your microphone's device index

```bash
python3 -c "
import pyaudio
p = pyaudio.PyAudio()
for i in range(p.get_device_count()):
    d = p.get_device_info_by_index(i)
    if d['maxInputChannels'] > 0:
        print(i, d['name'])
p.terminate()
"
```

Note the index number of your USB microphone.

### 3. Determine initial SOFTWARE_OFFSET

The `SOFTWARE_OFFSET` is an initial estimate that shifts the raw dBFS reading
to approximate dB(A) SPL. A typical value is around **+90 to +110 dB**,
depending on the microphone sensitivity.

Start with `SOFTWARE_OFFSET=100` and refine using the in-app calibration wizard
(Settings → Calibration), which places both sensors side-by-side and computes
the exact offset empirically.

### 4. Environment variables

Create `/etc/tramwatch/interior.env`:

```bash
TRAMWATCH_URL=https://your-app.vercel.app
TRAMWATCH_SECRET=your-ingest-secret-here
SOFTWARE_OFFSET=100.0
AUDIO_DEVICE_INDEX=1
AUDIO_SAMPLE_RATE=44100
AUDIO_CHUNK_SIZE=4096
FLUSH_INTERVAL=10
```

### 5. Install as systemd service

```bash
sudo cp interior_daemon.py /home/pi/tramwatch/interior_daemon.py
cat > /tmp/tramwatch-interior.service << 'EOF'
[Unit]
Description=TramWatch Interior Microphone Daemon
After=sound.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
EnvironmentFile=/etc/tramwatch/interior.env
ExecStart=/usr/bin/python3 /home/pi/tramwatch/interior_daemon.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
sudo cp /tmp/tramwatch-interior.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tramwatch-interior
sudo systemctl start tramwatch-interior
```

### 6. Verify

```bash
sudo systemctl status tramwatch-interior
journalctl -u tramwatch-interior -f
cat /tmp/tramwatch_interior.json
```

---

## Running a Calibration Session

1. Place both sensors side-by-side in open air (same room, away from walls).
2. Ensure no tram is passing.
3. In the TramWatch web app, go to **Calibration** → **Start Calibration Wizard**.
4. Select duration (30s / 60s / 120s recommended) → click Start.
5. The wizard records both sensors simultaneously and computes the offset.
6. Review ext_mean, int_mean, and offset → confirm to save.

The app retroactively corrects all stored interior readings with the new offset.

---

## GTFS Refresh Cron (Pi side — optional)

If you want to trigger GTFS refresh from the Pi (not via Vercel cron):

```bash
# /etc/cron.d/tramwatch-gtfs
0 3 * * 1 pi curl -s -X POST https://your-app.vercel.app/api/gtfs/refresh \
  -H "x-api-key: your-ingest-secret" >> /var/log/tramwatch-gtfs.log 2>&1
```

---

## Health Check

Both daemons write a JSON health file every second:

```bash
# Exterior
cat /tmp/tramwatch_exterior.json
# {"ts": "2024-01-15T14:23:01+00:00", "db_raw": 63.4, "source": "exterior", "buffer_size": 3}

# Interior
cat /tmp/tramwatch_interior.json
# {"ts": "2024-01-15T14:23:01+00:00", "db_raw": 47.2, "source": "interior", "software_offset": 100.0, "buffer_size": 3}
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Cannot open GM1356` | Check udev rule; try unplugging/replugging USB; verify `ls /dev/hidraw*` |
| `Cannot open audio stream` | Check `AUDIO_DEVICE_INDEX`; verify mic is plugged in; run device listing script |
| Readings not appearing in dashboard | Check `TRAMWATCH_URL` and `TRAMWATCH_SECRET` in env file; check journalctl for HTTP errors |
| Interior dB wildly off | Run calibration wizard; adjust `SOFTWARE_OFFSET` as starting point |
| Daemon crashes on startup | Check Python version (`python3 --version` ≥ 3.10 for `X | Y` type hints); if < 3.10, replace `float | None` with `Optional[float]` |
