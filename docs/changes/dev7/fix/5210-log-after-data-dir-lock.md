### Fixed

- Portable mode: a second launch of the same portable folder, which is refused because
  termiHub is already running from it, no longer creates or appends `data/logs/termihub.log`.
  The data-folder lock is now taken before the log file opens, so the refused launch leaves
  the shared `data/` folder completely untouched; the refusal message still prints to stderr.
