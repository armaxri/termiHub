### Changed

- Primary actions across several surfaces now drive their "working" feedback
  through the shared Button's async lifecycle (spinner + disabled + a
  `pendingLabel` on the pressed control) instead of a hand-rolled flag or a
  distant footer message (#1344):
  - **Network Tools**: verbs are now consistent per tool class. Streaming tools
    (Ping, Traceroute, Port Scanner, HTTP Monitor) share one **Start ↔ Stop**
    toggle — Traceroute and Port Scanner moved off "Run" to "Start" — with
    Starting…/Stopping… pending labels. One-shot tools (DNS Lookup, Open Ports,
    Wake-on-LAN) show their pending state on the button (Looking up…/Refreshing…/
    Sending…) rather than the gray "Querying…"/"Loading…" footer text, which was
    removed. Live streaming progress footers (e.g. "Scanning… N ports checked")
    are unchanged.
  - **Embedded servers**: the Start/Stop buttons now show the spinner on the
    pressed control while the action is in flight (replacing an internal busy
    flag).
  - **Connection editor**: Save & Connect now shows its pending state and, when
    the password prompt or credential-store unlock is dismissed, surfaces a
    recoverable "Connect canceled — your changes were saved." notice instead of
    silently finishing with a false success.
