# Serial Port Testing

This directory contains tools for testing termiHub's serial port functionality without physical hardware.

## Virtual Serial Port Pair

Use `socat` to create a linked pair of virtual serial ports:

```bash
../scripts/setup-virtual-serial.sh
```

This creates two pseudo-terminals:

| Path | Purpose |
|------|---------|
| `/tmp/termihub-serial-a` | Connect termiHub here |
| `/tmp/termihub-serial-b` | Connect the echo server (or another tool) here |

### Prerequisites

Install `socat`:

- **macOS**: `brew install socat`
- **Ubuntu/Debian**: `sudo apt install socat`
- **Fedora**: `sudo dnf install socat`

## Echo Server

A simple Python echo server that reads from one end of the virtual serial pair and echoes data back:

```bash
python3 serial-echo-server.py
```

By default it listens on `/tmp/termihub-serial-b`. Pass a custom path as the first argument:

```bash
python3 serial-echo-server.py /dev/pts/5
```

## Configuring termiHub

1. Start the virtual serial pair (keep the terminal open)
2. Start the echo server in another terminal (keep it open)
3. In termiHub, create a Serial connection:
   - **Port**: `/tmp/termihub-serial-a`
   - **Baud rate**: 9600 (any rate works with virtual ports)
   - **Data bits**: 8
   - **Stop bits**: 1
   - **Parity**: None
   - **Flow control**: None
4. Connect — anything you type should be echoed back

## Physical Hardware Testing

For testing with real serial devices:

1. Connect the device to your machine
2. Identify the port:
   - **macOS**: `/dev/tty.usbserial-*` or `/dev/tty.usbmodem*`
   - **Linux**: `/dev/ttyUSB0` or `/dev/ttyACM0`
   - **Windows**: `COM3`, `COM4`, etc.
3. Match the baud rate and serial parameters to your device's configuration
4. On Linux, ensure your user is in the `dialout` group: `sudo usermod -a -G dialout $USER`
