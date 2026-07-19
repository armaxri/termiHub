### Added

- The **Syntax Highlighting** settings section now supports **custom highlight
  rules**: add, edit, delete, and reorder your own pattern → style rules
  alongside the built-ins. An inline editor takes a name, a regex pattern,
  case-sensitive / whole-word toggles, and a style (color plus bold / italic /
  underline), with a live preview box that shows sample terminal output
  highlighted by the rule together with the other active rules. Custom rules are
  stored in the global `syntaxHighlighting` config and apply to open terminals
  immediately (#1703, epic #1696).
- **Regex safety for custom rules:** every custom pattern is validated before it
  can be saved — patterns that are empty, over-length (>500 chars), syntactically
  invalid, or prone to catastrophic backtracking (ReDoS) are rejected with an
  inline error and cannot be persisted. As a runtime backstop, the highlighting
  engine now scans each line under a per-line time budget and self-disables any
  rule that overruns it (logging a recoverable error), so a slow pattern can
  never freeze the terminal render loop.
