### Fixed

- Connection-failed dialog no longer shows Linux `dialout`-group instructions
  for a serial permission error on Windows or macOS. The advice is now
  host-OS aware: Linux still offers the copyable `sudo usermod -aG dialout $USER`
  fix, while Windows and macOS show generic guidance ("another application may
  be using the port, or you may not have permission to access it") with no bogus
  command. The backend permission-denied message is likewise platform-gated at
  its source (#1831).
