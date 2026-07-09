### Changed

- Tunnel sidebar rows now compose their action controls (Start, Stop, Retry,
  View last error, Edit, Duplicate, Delete) from the shared `Button` primitive
  instead of bespoke icon buttons. The async actions (Start / Stop / Retry) show
  a per-button pending spinner tied to the real backend call and flash success on
  completion, so the whole row is visually consistent with the rest of the app
  and every action gives immediate feedback (#1259, follow-up to #1240).
