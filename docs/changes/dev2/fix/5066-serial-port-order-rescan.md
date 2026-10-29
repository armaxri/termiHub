### Fixed

- Serial: the Port suggestions are now listed in natural order (COM3, COM9,
  COM10, COM27 … and `/dev/ttyUSB2` before `/dev/ttyUSB10`) instead of the
  arbitrary order Windows enumerates them in. Local and remote-agent port lists
  use the same order (#5066).

### Added

- Serial: while the serial connection editor is on screen, the port list is
  rescanned every 1.5 seconds, so a newly plugged adapter appears (and is
  announced as newly detected) and an unplugged one disappears within about two
  seconds. A selected port that is unplugged stays selected and is shown as
  "not connected". No scanning happens while the editor is hidden (#5066).
