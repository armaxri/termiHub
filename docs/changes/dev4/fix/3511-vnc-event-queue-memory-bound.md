### Security

- VNC: a hostile VNC server can no longer make termiHub buffer gigabytes of
  decoded image data from a small compressed stream. The VNC client's queue of
  decoded updates, and the queue from the VNC session to the viewer, are now
  bounded by memory (256 MiB of pixels each) as well as by count. When a queue is
  full, termiHub stops reading from the server until the viewer catches up,
  instead of dropping updates (#3511).
