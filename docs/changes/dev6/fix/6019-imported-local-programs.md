### Changed

- **An imported automation asks before it runs a local program** (#6019) — An automation that came from
  a file or a backup asks before each local program it has not run before, with the exact command.
  "Allow this command" remembers exactly that command for that automation; another program, file or
  argument asks again. The list of allowed programs is for the automations you made here. Existing
  automations and allowed programs keep working. A scheduled or triggered run of an imported automation
  whose command was not confirmed is refused with the reason.
- **"Always allow" warns about shells, interpreters and build tools** (#6019) — For a program that runs
  whatever it is told to (`sh`, `python`, `make`, `git`, `cmd`, …) it says so and asks again.
- **The question shows a command exactly** (#6019) — Spaces, empty arguments and characters that would not
  show or would reorder the text are visible.

### Security

- **Restoring settings no longer brings another computer's permissions** (#6018) — Experimental features,
  running local programs, the allowed programs and script files and the confirmed workspace commands stay
  as they are on this computer. The restore preview says so, and what the backup would have allowed.
