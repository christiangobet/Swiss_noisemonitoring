# TramWatch Pi Daemons

Setup guide for Raspberry Pi sensors streaming to TramWatch.

Both daemons post to `/api/browser-ingest` — **no API key required**.

---

## Hardware

| Pi | Sensor | Device |
|----|--------|--------|
| Pi #1 — Exterior | Benetech GM1356 USB SPL meter | USB HID, vendor `0x64BD`, product `0x74E3` |
| Pi #2 — Interior | Any USB microphone | PyAudio input |

---

## Prerequisites (both Pis)

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y python3-pip python3-dev git
```

---

## Pi #1 — Exterior (GM1356 SPL meter)

### 1. Install dependencies

```bash
sudo apt-get install -y libhidapi-dev
pip3 install hidapi requests
```

### 2. udev rule (USB access without sudo)

Create `/etc/udev/rules.d/99-gm1356.rules`:

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="64bd", ATTRS{idProduct}=="74e3", MODE="0666"
```

Apply:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Verify the device is visible:

```bash
ls -la /dev/hidraw*
```

### 3. Copy the daemon

```bash
sudo mkdir -p /home/pi/tramwatch
sudo cp exterior_daemon.py /home/pi/tramwatch/
```

### 4. Environment file

Create `/etc/tramwatch/spl.env`:

```
TRAMWATCH_URL=https://your-app.vercel.app
SOURCE_NAME=exterior
FLUSH_INTERVAL=2
SAMPLE_INTERVAL=1
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TRAMWATCH_URL` | *(required)* | Base URL of your deployed TramWatch app |
| `SOURCE_NAME` | `pi-spl` | Name shown in the live chart (max 32 chars, `[a-zA-Z0-9_-]`) |
| `FLUSH_INTERVAL` | `2` | Seconds between POSTs to the server |
| `SAMPLE_INTERVAL` | `1` | Seconds between SPL meter reads |
| `HEALTH_FILE` | `/tmp/tramwatch_spl.json` | Path for the health status JSON |

### 5. Install as systemd service

```bash
sudo mkdir -p /etc/tramwatch

cat > /tmp/tramwatch-spl.service << 'EOF'
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
EOF

sudo cp /tmp/tramwatch-spl.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tramwatch-spl
sudo systemctl start tramwatch-spl
```

### 6. Verify

```bash
sudo systemctl status tramwatch-spl
journalctl -u tramwatch-spl -f
cat /tmp/tramwatch_spl.json
```

Expected health file:

```json
{"ts": "2024-01-15T14:23:01+00:00", "db_raw": 63.4, "source": "exterior", "buffer_size": 3}
```

---

## Pi #2 — Interior (USB microphone)

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

### 3. Copy the daemon

```bash
sudo mkdir -p /home/pi/tramwatch
sudo cp interior_daemon.py /home/pi/tramwatch/
```

### 4. Environment file

Create `/etc/tramwatch/mic.env`:

```
TRAMWATCH_URL=https://your-app.vercel.app
SOURCE_NAME=interior
SOFTWARE_OFFSET=100.0
AUDIO_DEVICE_INDEX=1
AUDIO_SAMPLE_RATE=44100
AUDIO_CHUNK_SIZE=4096
FLUSH_INTERVAL=2
```

| Variable | Default | Description |
|----------|---------|-------------|
| `TRAMWATCH_URL` | *(required)* | Base URL of your deployed TramWatch app |
| `SOURCE_NAME` | `pi-mic` | Name shown in the live chart (max 32 chars, `[a-zA-Z0-9_-]`) |
| `SOFTWARE_OFFSET` | `0.0` | Coarse dBFS→SPL offset; start at `100.0`, refine via calibration wizard |
| `AUDIO_DEVICE_INDEX` | *(system default)* | Leave blank for default; use index from step 2 |
| `AUDIO_SAMPLE_RATE` | `44100` | Sample rate in Hz |
| `AUDIO_CHUNK_SIZE` | `4096` | PCM frames per read |
| `FLUSH_INTERVAL` | `2` | Seconds between POSTs to the server |
| `HEALTH_FILE` | `/tmp/tramwatch_mic.json` | Path for the health status JSON |

### 5. Install as systemd service

```bash
sudo mkdir -p /etc/tramwatch

cat > /tmp/tramwatch-mic.service << 'EOF'
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
EOF

sudo cp /tmp/tramwatch-mic.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tramwatch-mic
sudo systemctl start tramwatch-mic
```

### 6. Verify

```bash
sudo systemctl status tramwatch-mic
journalctl -u tramwatch-mic -f
cat /tmp/tramwatch_mic.json
```

Expected health file:

```json
{"ts": "2024-01-15T14:23:01+00:00", "db_raw": 47.2, "source": "interior", "software_offset": 100.0, "buffer_size": 3}
```

---

## Calibration

Once both daemons are running:

1. Place both sensors side-by-side in the same room, away from walls.
2. In TramWatch, go to **Settings → Calibration → Start Calibration Wizard**.
3. Select duration (60s recommended) → click Start.
4. Review `ext_mean`, `int_mean`, and computed `offset` → confirm to save.

The app retroactively applies the new offset to all stored interior readings.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Cannot open GM1356` | Check udev rule; unplug/replug USB; verify `ls /dev/hidraw*` |
| `Cannot open audio stream` | Check `AUDIO_DEVICE_INDEX`; verify mic is plugged in; run device listing above |
| Readings not appearing in dashboard | Check `TRAMWATCH_URL` in env file; check `journalctl` for HTTP errors |
| Interior dB wildly off | Run calibration wizard; adjust `SOFTWARE_OFFSET` as starting point |
| Daemon crashes on startup | Requires Python ≥ 3.10 for `X \| Y` type hints; if older, replace `float \| None` with `Optional[float]` |
| Service won't start | Run `journalctl -u tramwatch-spl -n 50` or `journalctl -u tramwatch-mic -n 50` |
