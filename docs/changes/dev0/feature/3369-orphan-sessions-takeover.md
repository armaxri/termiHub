### Changed

- When the termiHub agent restarts, persistent sessions that no open desktop tab refers to are
  now **left running unattached** instead of being silently claimed by whichever desktop
  reconnects first. Nobody owns them until you pick one.

### Added

- **Running Sessions…** in a connected agent's context menu lists every session running on
  that host — including orphaned ones and ones another desktop is using. **Open** attaches an
  unattached session in a new tab (with its scrollback); **Take over** moves a session another
  desktop is using to this one after a confirmation (the other desktop sees "Taken over by
  another desktop" and can reclaim it). Older agents show why the list is unavailable.
- Opening an agent session that was not started from a saved connection now attaches to that
  running session instead of starting a new one.
