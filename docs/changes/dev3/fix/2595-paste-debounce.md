### Fixed

- Right-click paste no longer inserts the clipboard content twice. On Windows a single
  right-click could deliver a duplicated/bounced mouse signal that fired the paste action
  more than once for one gesture, pasting the text twice. A short per-terminal guard
  (50 ms, default-on) now drops a second paste trigger that arrives that quickly for the
  same terminal, so one right-click pastes exactly once. The guard is keyed per terminal,
  so deliberate pastes spaced normally and near-simultaneous pastes into different
  terminals are unaffected, and it covers every paste path (right-click, context-menu
  Paste, and Cmd/Ctrl+V) since they all funnel through one choke point (#2595).
