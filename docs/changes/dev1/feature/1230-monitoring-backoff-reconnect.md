# Monitoring: automatic bounded backoff reconnect

## Added

- Remote system monitoring now **automatically reconnects** after a transient
  transport drop. Once a monitored host goes `Stale`, the collector re-dials the
  connection under a capped exponential backoff (1 s → 30 s cap, up to 8
  attempts), reporting `Reconnecting` while it retries and returning to `Live`
  as soon as a re-dial succeeds — no manual Kill / re-pick needed. ([#1230])

## Changed

- When the backoff budget is exhausted, monitoring now resolves to an explicit
  `Offline` status and stops retrying, instead of silently staying dead. The
  agent's monitoring loop mirrors the same auto-reconnect and `Offline`
  behavior. ([#1230])

[#1230]: https://github.com/armaxri/termiHub/issues/1230
