### Changed

- Sidebar: when Remote agents lists an agent, the empty Saved group shows a
  single "No saved connections. New connection" line instead of the large
  first-run card, so the agents stay near the top. The card itself is now one
  sentence and a button, with the experimental-features hint as a smaller
  secondary line (#5702).
- Sidebar: a disconnected agent's Connect, Reconnect or Cancel action sits on the
  agent's name row instead of a second row (#5702).

### Fixed

- Empty-state links now use the theme's link colour, which meets WCAG AA on the
  sidebar in every built-in theme; in Solarized Dark they were hard to read
  (#5702).
- The empty window's second button reads "New connection" when there is no
  saved connection, matching the "create a connection" text above it (#5702).
