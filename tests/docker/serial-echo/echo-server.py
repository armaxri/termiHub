#!/usr/bin/env python3
"""Serial port echo server for termiHub testing.

Reads from a virtual serial port and echoes back with optional transformations.
Supports multiple modes for testing different serial behaviors.

Usage:
    echo-server.py <port_path> [--mode=echo|uppercase|hex|slow]
"""

import argparse
import os
import sys
import time


def echo_mode(port_path: str) -> None:
    """Simple echo: return exactly what was received."""
    with open(port_path, "rb+", buffering=0) as port:
        while True:
            data = port.read(1024)
            if data:
                port.write(data)
                port.flush()


def uppercase_mode(port_path: str) -> None:
    """Echo back in uppercase (tests data transformation)."""
    with open(port_path, "rb+", buffering=0) as port:
        while True:
            data = port.read(1024)
            if data:
                port.write(data.upper())
                port.flush()


def hex_mode(port_path: str) -> None:
    """Echo back as hex string (tests binary data handling)."""
    with open(port_path, "rb+", buffering=0) as port:
        while True:
            data = port.read(1024)
            if data:
                hex_str = data.hex().encode("ascii") + b"\n"
                port.write(hex_str)
                port.flush()


def slow_mode(port_path: str) -> None:
    """Echo back one byte at a time with 50ms delay (tests buffering)."""
    with open(port_path, "rb+", buffering=0) as port:
        while True:
            data = port.read(1024)
            if data:
                for byte in data:
                    port.write(bytes([byte]))
                    port.flush()
                    time.sleep(0.05)


MODES = {
    "echo": echo_mode,
    "uppercase": uppercase_mode,
    "hex": hex_mode,
    "slow": slow_mode,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Serial echo server for testing")
    parser.add_argument("port_path", help="Path to the virtual serial port")
    parser.add_argument(
        "--mode",
        choices=MODES.keys(),
        default="echo",
        help="Echo mode (default: echo)",
    )
    args = parser.parse_args()

    # Wait for the port to become available
    for _ in range(30):
        if os.path.exists(args.port_path):
            break
        time.sleep(0.5)
    else:
        print(f"ERROR: Port {args.port_path} not available after 15s", file=sys.stderr)
        sys.exit(1)

    print(f"Serial echo server started: {args.port_path} (mode={args.mode})")
    MODES[args.mode](args.port_path)


if __name__ == "__main__":
    main()
