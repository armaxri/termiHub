### Changed

- Deleting a saved workspace now asks for confirmation first and reports the
  result. Previously delete was a one-click destructive action with no confirm
  and no feedback: a failed delete was swallowed silently and the workspace
  reappeared on the next refresh with no explanation. The delete now opens a
  confirmation dialog, only removes the workspace after the backend confirms,
  and shows a success or error toast. Part of the workspace save/restore audit
  (#1146, gap G7).
