### Fixed

- VNC: ported the security and robustness fixes from the upstream vnc-rs 0.6.0
  release into termiHub's vendored VNC client. The authentication handshake now
  checks the server's result codes strictly (an unexpected value can no longer
  be misread, or skip authentication on RFB 3.3), ignores unknown security types
  instead of failing, and no longer waits for a failure reason that RFB 3.3
  servers never send. Unusable pixel formats, updates in encodings the client
  never asked for, and rectangles outside the desktop now end the session with a
  clear protocol error. Disconnecting no longer hangs when a server stops
  reading or sends data faster than it can be decoded.
- RDP: a malformed audio message from the server is now ignored instead of
  ending the whole remote-desktop session, and audio keeps playing after
  unsupported optional audio messages.
