### Fixed

- Linux Thunar integration: editing or removing termiHub's custom action no
  longer strips hand-written comments and formatting from
  `~/.config/Thunar/uca.xml`. The rewrite now copies the verbatim source bytes
  of each foreign `<action>` and everything between them (comments, blank
  lines, indentation), so only termiHub's own action is added or removed —
  every foreign action and its surrounding whitespace/comments round-trips
  byte-intact (#1417).
