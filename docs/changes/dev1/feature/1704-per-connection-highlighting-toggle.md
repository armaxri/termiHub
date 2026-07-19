### Added

- Terminal output syntax highlighting can now be controlled per connection and
  per session:
  - **Connection Editor → Terminal** gains a **Syntax Highlighting** override
    (`Use global default` / `Always on` / `Always off`) that forces highlighting
    on or off for that connection regardless of the global switch.
  - The **status bar** shows a `Highlighting: ON/OFF` indicator for the active
    terminal session (visible once the feature is enabled or effectively on).
    Clicking it flips a temporary, non-persisted per-session toggle — reconnect
    or reopen returns to the resolved default (#1704, epic #1696).
