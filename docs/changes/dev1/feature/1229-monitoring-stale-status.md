# Monitoring: explicit Stale status on a mid-stream drop

## Added

- Remote system monitoring now tracks an explicit lifecycle **status**
  (`Connecting` / `Live` / `Stale` / `Reconnecting` / `Offline` / `Paused`)
  alongside the stats stream. The collector loop counts consecutive collect
  failures and reports `Stale` when the transport drops mid-stream, then `Live`
  again on recovery. ([#1229])

## Changed

- The status-bar monitoring segment no longer renders frozen CPU / memory / disk
  numbers as if they were live. When the connection to a monitored host drops,
  the numbers are dimmed and a warning **Stale** badge appears; they return to
  normal automatically once monitoring recovers. ([#1229])

[#1229]: https://github.com/armaxri/termiHub/issues/1229
