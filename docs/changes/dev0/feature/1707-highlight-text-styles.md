### Added

- Syntax-highlighting rules now render **bold**, _italic_ and underline, not
  just color. Built-in rules that set `underline` (URLs, email addresses) now
  visibly underline matched text, and custom rules can combine color with any of
  bold/italic/underline. Server-set ANSI colors are still never overridden.
  Follow-up to the syntax-highlighting engine (#1697, #1707).
