### Added

- **Confirmed commands in Settings** (#6057) — Settings → Security lists the commands you confirmed for each
  imported automation. You can revoke one, all of an automation, or all. An allowed program that runs
  whatever it is told to (`sh`, `python`, …) says so in the list of allowed programs.

### Security

- **A restored backup starts nothing by itself** (#6056) — Schedules, triggers, tunnels and file servers that
  start by themselves arrive switched off, and a restored workspace asks before it runs its commands. The
  restore preview says which and what would start them; after the restart termiHub asks which to turn on.
  What is already on here and does the same stays on.
