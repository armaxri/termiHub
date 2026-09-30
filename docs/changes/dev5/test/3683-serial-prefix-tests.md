### Fixed

- Disabling a serial port scan prefix in Settings → Serial now hides all matching ports on
  Linux, including the ones the system serial library lists on its own (e.g. real `/dev/ttyS*`
  UARTs). Previously only ports found by the extra `/dev` scan were hidden (#3683).
