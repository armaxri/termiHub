### Changed

- Far fewer toasts (#5859). termiHub no longer shows a success toast for a result you can
  already see: saving a connection, tunnel, macro, workflow, schedule or workspace (the row
  appears), connecting a tab (its dot turns green), flipping a setting, playing a macro or
  running a workflow in the visible terminal, creating, renaming or deleting files, and stopping
  or pausing monitors and transfers. Toasts remain for failures, for things that finish in the
  background or off-screen (transfers, scheduled and automatic runs, agent reconnects, clipboard
  copies, files written to disk) and for undo offers such as "Closed … · Reopen".
- A finished transfer is reported once: while the file browser shows its "1 transfer done"
  line, no "Downloaded …" toast repeats it.
- The connection editor's Test now shows its result beside the Test button ("Reached web —
  Nothing was saved.") instead of in a toast.
