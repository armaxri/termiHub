#!/usr/bin/env python3
"""
Simple serial echo server for testing TermiHub serial connections.

Reads from a virtual serial port and echoes each line back with a prefix.
Useful with the virtual serial pair created by setup-virtual-serial.sh.

Usage:
    python3 serial-echo-server.py [port]

    port  Path to the serial device (default: /tmp/termihub-serial-b)
"""

import sys
import os
import time


def main():
    port = sys.argv[1] if len(sys.argv) > 1 else "/tmp/termihub-serial-b"

    if not os.path.exists(port):
        print(f"Error: {port} does not exist.")
        print("Run setup-virtual-serial.sh first to create the virtual serial pair.")
        sys.exit(1)

    print(f"Echo server listening on {port}")
    print("Press Ctrl+C to stop.\n")

    with open(port, "r+b", buffering=0) as f:
        while True:
            data = f.read(1)
            if data:
                # Echo back the received byte
                f.write(data)
                f.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nEcho server stopped.")
