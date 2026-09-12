### Fixed

- The Transfer Queue's per-row Pause/Resume/Cancel/Retry controls no longer show
  a success toast when the action did nothing. Previously every control reported
  success unconditionally: a failed command (session gone, backend error) failed
  silently with no feedback, and Pause/Resume/Retry on the common SSH/SFTP path —
  which the queue does not yet implement — still claimed success while the
  transfer kept running. The controls now reflect the real backend outcome: a
  success toast only on a genuine state change, an accurate "not available for
  this transfer" message on a no-op, and an error toast on failure
  (audit FEC-004 / UX-016).
