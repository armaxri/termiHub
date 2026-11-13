### Changed

- Tabs now size to their title: a name like "Startup question (zsh)" is shown in
  full (up to 240px) and tabs only shrink, down to 120px, once the tab strip is
  full. The full title is always in the tab's tooltip, and a tab with unsaved
  changes says so in its tooltip next to the grey dot (#5557).
- Editor headings use sentence case ("Edit connection", "New SSH tunnel") (#5557).
- Command marks in the terminal gutter (OSC 133) are drawn at full strength, so a
  failed command stands out, and hovering a mark shows the command's exit code
  (#5563).
- The status-bar host stats are one labelled group set off by a divider, named
  after the host they describe ("This computer" for a local shell). CPU is hidden
  until its first real sample instead of showing "CPU —", and stats are coloured
  only near exhaustion (amber from 90%, red from 95%) instead of permanently on an
  idle machine (#5563).
