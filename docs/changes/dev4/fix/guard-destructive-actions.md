### Added

- Launching a workspace now asks for confirmation before it closes your live
  sessions. A workspace launch tears down every open terminal/SSH/serial session
  and replaces the whole layout; that destructive step previously fired on a
  single click or Enter with no prompt, while the reversible Delete was already
  guarded. The confirmation names how many open sessions would be closed and only
  appears when there are live sessions to lose — launching with nothing running
  is unchanged (UX-026).
- Stopping or force-reconnecting a live SSH tunnel now asks for confirmation
  first. Both actions drop every connection currently forwarded through the
  tunnel; they previously fired immediately on a single click. The prompt only
  appears for a connected tunnel that is carrying forwards — stopping a
  still-connecting tunnel (a cheap cancel) is unchanged (UX-021).
