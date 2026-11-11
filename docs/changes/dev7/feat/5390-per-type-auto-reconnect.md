### Added

- Serial connections now reopen their port automatically when a USB adapter is unplugged and
  plugged back in, like Tera Term's COM-port auto-reconnect. Auto-Reconnect is on by default
  for serial. The tab shows the same reconnect strip, countdown and Cancel as SSH, gives up
  after the usual 10 attempts, and reopens the port with the saved line settings. Only the
  configured port is reopened; on Linux a different adapter under the same name is not
  opened (#5390).
- Telnet connections have an Auto-Reconnect switch, off by default. When on, a dropped
  telnet connection is retried in the same tab with the same backoff as SSH (#5390).
