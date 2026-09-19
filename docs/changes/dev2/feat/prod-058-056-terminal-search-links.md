### Added

- The terminal search bar now shows a live match count ("current / total", or
  "No results" when nothing matches) and gains a "Match Whole Word" toggle
  alongside the existing case-sensitive and regular-expression options. All
  matches are highlighted as you search (PROD-058).
- URLs printed in terminal output are now clickable. Clicking a link opens it in
  your default browser through the app's scheme allowlist, so only http, https,
  and mailto links are ever handed to the OS (PROD-056).
