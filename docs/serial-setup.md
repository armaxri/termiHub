# Serial Port Setup

This guide covers how to configure serial port connections in termiHub on each platform.

---

## Platform Setup

### macOS

Serial devices appear under `/dev/tty.*` when connected. Common paths:

| Device | Path |
|--------|------|
| USB-to-serial adapter | `/dev/tty.usbserial-*` |
| USB-to-serial (FTDI) | `/dev/tty.usbserial-FTDI*` |
| USB-to-serial (CH340) | `/dev/tty.wchusbserial*` |
| Arduino / similar | `/dev/tty.usbmodem*` |
| Bluetooth serial | `/dev/tty.Bluetooth-*` |

**USB driver installation**: Most modern USB-to-serial adapters work out of the box on macOS. If your device is not recognized:

1. Check the chipset on the adapter (usually FTDI, CH340, CP210x, or PL2303)
2. Download the driver from the manufacturer:
   - [FTDI drivers](https://ftdichip.com/drivers/vcp-drivers/)
   - [CH340 drivers](https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html)
   - [CP210x drivers](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
3. Install and restart your Mac
4. The device should appear in termiHub's port dropdown

**Tip**: Run `ls /dev/tty.*` in a terminal to list all available serial devices.

### Linux

Serial devices appear under `/dev/ttyUSB*` or `/dev/ttyACM*`. Common paths:

| Device | Path |
|--------|------|
| USB-to-serial adapter | `/dev/ttyUSB0` |
| Arduino / ACM device | `/dev/ttyACM0` |
| Built-in serial port | `/dev/ttyS0` |

**Permissions**: By default, serial ports require root access. Add your user to the `dialout` group:

```bash
sudo usermod -a -G dialout $USER
```

Log out and back in for the change to take effect. Verify:

```bash
groups | grep dialout
```

**Udev rules (optional)**: Create a udev rule for persistent device names:

```bash
# Find device attributes
udevadm info -a -n /dev/ttyUSB0 | grep -E 'idVendor|idProduct|serial'

# Create rule
sudo tee /etc/udev/rules.d/99-serial.rules << 'EOF'
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", SYMLINK+="tty_mydevice"
EOF

# Reload rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

The device will then be available as `/dev/tty_mydevice` in addition to its `/dev/ttyUSB*` path.

**USB drivers**: Most chipsets are supported by the Linux kernel. If a device is not recognized, check `dmesg` output after plugging it in:

```bash
dmesg | tail -20
```

### Windows

Serial devices appear as COM ports (e.g., `COM3`, `COM4`).

**Finding the port**:

1. Open **Device Manager** (right-click Start menu)
2. Expand **Ports (COM & LPT)**
3. Look for your device (e.g., "USB-SERIAL CH340 (COM3)")

**Driver installation**: Windows usually installs drivers automatically via Windows Update. If not:

1. Check the chipset (printed on the adapter or in Device Manager under the device's properties)
2. Download from the manufacturer (same links as macOS section above)
3. Install and check Device Manager again

**Tip**: termiHub auto-detects available COM ports in the connection editor. If no ports appear in the dropdown, enter the port name manually (e.g., `COM3`).

---

## Configuration Parameters

When creating a serial connection in termiHub, configure these parameters to match your device:

| Parameter | Options | Default | Description |
|-----------|---------|---------|-------------|
| Port | Auto-detected or manual | — | Serial port path |
| Baud Rate | 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600 | 9600 | Data transfer speed (bits/second) |
| Data Bits | 5, 6, 7, 8 | 8 | Number of data bits per frame |
| Stop Bits | 1, 2 | 1 | Number of stop bits per frame |
| Parity | None, Odd, Even | None | Error-checking method |
| Flow Control | None, Hardware (RTS/CTS), Software (XON/XOFF) | None | Data flow regulation |

### Common Configurations

**Most embedded devices** (Arduino, ESP32, STM32, etc.):
- Baud Rate: 115200
- Data Bits: 8
- Stop Bits: 1
- Parity: None
- Flow Control: None

**Legacy serial devices**:
- Baud Rate: 9600
- Data Bits: 8
- Stop Bits: 1
- Parity: None
- Flow Control: None

**Industrial equipment (Modbus RTU)**:
- Baud Rate: 9600 or 19200
- Data Bits: 8
- Stop Bits: 1 or 2
- Parity: Even or None
- Flow Control: None

Check your device's documentation for the correct settings. Mismatched baud rate is the most common cause of garbled output.

---

## Testing with Virtual Serial Ports

termiHub includes scripts for creating virtual serial ports, which is useful for testing without physical hardware.

### Setup (Linux/macOS)

Requires `socat` and Python 3:

```bash
# Install socat
# macOS:
brew install socat
# Ubuntu/Debian:
sudo apt install socat

# Create virtual serial port pair
cd examples/serial
./setup-virtual-serial.sh
```

This creates two linked virtual ports:
- `/tmp/termihub-serial-a` — Connect termiHub to this port
- `/tmp/termihub-serial-b` — Used by the echo server

### Running the Echo Server

```bash
cd examples/serial
python3 serial-echo-server.py
```

The echo server reads from port B and echoes back whatever is sent. Connect termiHub to port A and type to test.

See [examples/README.md](../examples/README.md) for full test environment setup.

---

## Troubleshooting

### Port not appearing in dropdown

- **All platforms**: Unplug and replug the device, then click **Refresh** or re-open the connection editor
- **Linux**: Check permissions — run `ls -la /dev/ttyUSB0` and ensure your user is in the `dialout` group
- **macOS**: Check if a driver is needed for your adapter chipset
- **Windows**: Check Device Manager for driver issues (yellow warning triangle)

### Garbled output

- **Baud rate mismatch**: This is the most common cause. Verify the baud rate matches your device's configuration.
- **Data bits / parity mismatch**: Less common, but check your device's documentation.

### "Permission denied" (Linux)

```bash
# Add user to dialout group
sudo usermod -a -G dialout $USER
# Log out and log back in
```

### "Port is busy" / "Access denied"

Another application (e.g., Arduino IDE, minicom, screen) may have the port open. Close that application first — serial ports can only be opened by one application at a time.

### Device disconnects unexpectedly

- Check the USB cable — loose or damaged cables cause intermittent disconnections
- Try a different USB port
- On Linux, check `dmesg` for USB error messages
