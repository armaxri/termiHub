#!/bin/bash
# Start virtual serial port pairs and echo servers
set -e

echo "Creating virtual serial port pair A/B (standard echo)..."
socat -d -d \
    PTY,raw,echo=0,link=/tmp/termihub-serial-a \
    PTY,raw,echo=0,link=/tmp/termihub-serial-b &
SOCAT_PID1=$!

echo "Creating virtual serial port pair C/D (uppercase echo)..."
socat -d -d \
    PTY,raw,echo=0,link=/tmp/termihub-serial-c \
    PTY,raw,echo=0,link=/tmp/termihub-serial-d &
SOCAT_PID2=$!

# Wait for ports to be created
sleep 1

# Set permissions so they're accessible
chmod 666 /tmp/termihub-serial-a /tmp/termihub-serial-b \
          /tmp/termihub-serial-c /tmp/termihub-serial-d 2>/dev/null || true

echo "Starting echo server on port B (standard echo mode)..."
python3 /usr/local/bin/echo-server.py /tmp/termihub-serial-b --mode=echo &
ECHO_PID1=$!

echo "Starting echo server on port D (uppercase mode)..."
python3 /usr/local/bin/echo-server.py /tmp/termihub-serial-d --mode=uppercase &
ECHO_PID2=$!

echo "Serial test environment ready."
echo "  Port A (client): /tmp/termihub-serial-a → echo"
echo "  Port C (client): /tmp/termihub-serial-c → uppercase echo"

# Wait for any process to exit (indicates failure)
cleanup() {
    kill $SOCAT_PID1 $SOCAT_PID2 $ECHO_PID1 $ECHO_PID2 2>/dev/null
    exit 0
}
trap cleanup SIGTERM SIGINT

wait -n
echo "A process exited unexpectedly"
cleanup
