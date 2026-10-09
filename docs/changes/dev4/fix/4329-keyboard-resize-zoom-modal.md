### Fixed

- Accessibility: the sidebar width handle and the separator between sidebar
  sections are now focusable separators. Arrow keys resize them, and Home/End
  jump the sidebar to its narrowest or widest (#4329).
- Accessibility: tabs and tab groups can be moved without dragging. A focused
  tab moves with Ctrl+Shift+Left/Right (Cmd+Shift+Left/Right on macOS), and the
  tab and tab-group context menus offer Move Left and Move Right. Tabs also get
  Move to New Panel (#4329).
- Accessibility: Shell Integration quick-access entries have Move up/Move down
  buttons, so their order (which picks the default entry) can be changed from
  the keyboard (#4329).
- Accessibility: the zoom overlay is a proper modal dialog. It is labelled with
  the tab's title, keeps focus inside, and returns focus when it closes. Escape
  now reaches a zoomed terminal or editor (vim, less, fzf), and Shift+Escape
  closes the overlay from there. Elsewhere in the overlay, Escape still closes
  it (#4329).
