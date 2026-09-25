### Changed

- Persistent agent sessions are now explicitly **single-attach** (SM-003): only one
  desktop controls a session at a time. When another desktop attaches to a session
  you are using, your tab no longer shows a confusing disconnect, a stuck
  "Reconnecting…" or a false "Session lost" — it shows **"Taken over by another
  desktop"** with a **Reclaim** button. The session keeps running; input is paused
  in the evicted tab and nothing reconnects on its own (which would steal control
  back and forth). Reclaim takes control back, and the other desktop is shown the
  same notice in turn. The tab-strip status icon marks evicted tabs, and broadcast
  input skips them. Mixing with an older agent or desktop keeps today's behaviour.
