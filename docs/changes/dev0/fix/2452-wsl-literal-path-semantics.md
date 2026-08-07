### Fixed

- WSL connection settings are now correctly documented and advertised as
  **literal**: the `startingDirectory`, `initialCommand`, and `env` fields no
  longer claim `~` / `${VAR}` expansion in the settings schema. termiHub never
  expanded WSL values (the connect path spawns `wsl.exe` directly, and the guest
  resolves `~` and environment references itself); the schema previously
  advertised host-side expansion that would corrupt Linux paths (`~` →
  `C:\Users\…`). The schema now matches the connect path — a value like
  `~/projects` reaches `wsl --cd ~/projects` verbatim. Behaviour is unchanged;
  the schema is now honest (#2452, concept #2360).
