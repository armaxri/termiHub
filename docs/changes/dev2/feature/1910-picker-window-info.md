### Changed

- Multi-window: the tab context menu's **Move to Window ▸** picker now shows each
  other window's live **tab count** next to its name ("2 tabs" / "1 tab" /
  "empty"), matching the concept mockup — the current window still reads
  "current". The count comes from real per-window state: each window reports its
  own tab count to the backend window registry (tabs live in separate JS
  contexts, so a window cannot see another's directly), and the picker reads the
  reported counts back (#1910, epic #1899).
