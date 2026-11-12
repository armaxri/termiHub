### Changed

- Serial auto-reconnect now checks the USB identity of the adapter (vendor, product and serial
  number) on macOS and Windows too. A different USB adapter that shows up under the configured
  port name is not opened there either, and an adapter with a serial number is followed when it
  comes back under a new name (for example `COM7` instead of `COM3`) (#5394).
