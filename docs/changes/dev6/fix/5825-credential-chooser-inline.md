### Fixed

- The "Where should termiHub keep passwords?" chooser no longer covers the
  Password field and the Save credentials switch with a "Passwords will be
  stored in…" toast. The save control that opened it now names the chosen
  store on a line right under itself, and the editor scrolls that row fully
  into view (#5825).
- Dismissing the chooser after ticking a save box now says what it does —
  "Don't save this password" — and the box stays visibly unticked (#5825).
- The master-password step shows a live checklist (at least 8 characters,
  passwords match) instead of a silently disabled Create vault, and Back now
  sits alone at the left edge of the footer (#5825).
