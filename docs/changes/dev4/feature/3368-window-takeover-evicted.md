### Changed

- A session shown in more than one termiHub window is now controlled by exactly one
  window (SM-003, single-attach for windows). When another window takes a session
  over, the previous window no longer just loses resize — it shows **"Taken over by
  another window"** with a **Reclaim** button, and its typing, pasting and resizing
  are ignored (enforced by the app backend too, not only the screen). Nothing
  takes control back on its own; Reclaim does, and the other window is shown the
  same notice in turn. After reclaiming, the window repaints the output it missed.
  Broadcast input skips tabs another window controls.
