### Fixed

- SSH: rejecting a server's host key in the trust prompt no longer reports
  "Connection failed / SSH handshake failed" with a Retry that only re-shows
  the prompt. The tab now says "You rejected the host key" and offers
  **Review key** (reconnect and see the prompt again) and **Edit connection**
  (#5185).
- SSH: the time the host-key trust prompt is open no longer counts against the
  connect timeout, for direct and jump-host connections, so comparing a
  fingerprint does not time the connect out. An unanswered prompt still gives
  up after 5 minutes (#5185).
- SSH: aborting a connect, or a connect timing out, while its host-key prompt is
  open now closes the prompt, and an answer given to it afterwards is ignored —
  a stale "Accept for host" can no longer remember a key for a connect that no
  longer exists (#5185).

### Changed

- SSH / RDP: when a host key or certificate **changed** since you last trusted
  it, the trust prompt now leads with **Reject**; "Accept once" is a small,
  separate button so continuing never looks like the default while the
  possible-interception warning is shown (#5185).
