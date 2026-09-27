### Changed

- Reconnect: every automatic reconnect now follows one retry policy — SSH and
  agent-hosted terminal tabs, the remote agent connection, SSH tunnels, VNC/RDP sessions
  and system monitoring. After a dropped link termiHub retries up to **10 times**, first
  after about a second and then with growing pauses of at most 30 seconds, and gives up
  after at most about three minutes of waiting. Tunnels used to give up after 5 attempts,
  VNC/RDP after 3 and monitoring after 8; they now keep trying for the same 10. The FTP
  file browser keeps its short in-line retry (3 quick retries) because you are waiting on
  the file operation (#3730).
- Reconnect: each pause is now randomly shortened by up to half, so many tabs, tunnels or
  monitors dropped by the same outage no longer all reconnect at the same instant. A pause
  never gets longer than before and never drops to zero (#3730).
- VNC/RDP: the reconnecting overlay now reads like a terminal tab's — "Connection lost —
  reconnecting…" with "Attempt 2 of 10" (#3730).
- Monitoring: the status bar shows one status at a time — Offline, then Reconnecting,
  then Stale, then Paused — so a paused monitor whose connection drops shows the
  connection problem instead of "Paused". While connecting for the first time, the host
  button's tooltip now says "Connecting to …" instead of "Reconnecting to …" (#3730).
