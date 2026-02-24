# Virtual serial port testing with socat + echo server
# Creates virtual serial port pairs and runs configurable echo servers
# Supports multiple baud rate testing scenarios
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    socat \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy the echo server script
COPY echo-server.py /usr/local/bin/echo-server.py
RUN chmod +x /usr/local/bin/echo-server.py

# Startup script: create virtual serial ports and start echo servers
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# The virtual serial port paths (accessible via volume mount or exec)
# Port A: /tmp/termihub-serial-a (client side)
# Port B: /tmp/termihub-serial-b (echo server side)
# Port C: /tmp/termihub-serial-c (second pair, client side)
# Port D: /tmp/termihub-serial-d (second pair, echo server side - different behavior)

CMD ["/usr/local/bin/start.sh"]
