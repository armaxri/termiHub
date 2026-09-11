### Fixed

- The file editor's "Save & Close" no longer discards unsaved edits when the
  save does not actually succeed (FEC-010). Previously the tab was closed
  unconditionally after saving, so edits were silently lost on a failed save
  (permission denied / read-only remote), when the sudo password prompt was
  still open, or when the "Save As…" dialog for an unsaved scratch buffer was
  cancelled. The tab now closes only once the file has really been written: a
  failed save keeps the tab open with its error banner, a cancelled Save-As
  keeps the scratch buffer, and on the sudo path the close is deferred until the
  elevated write is authorized (cancelling the prompt keeps the tab open).
