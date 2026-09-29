### Fixed

- Launching termiHub again with `--workspace <name>` or `--workspace-file <file>`
  while it is already running now opens that workspace in the running window,
  instead of only focusing it and dropping the arguments. Unknown arguments are
  ignored and logged (#3101).
- Launching the same portable termiHub folder twice no longer lets both copies
  write the shared `data/` directory: the second launch shows an "already
  running" error and exits. Portable copies in different folders still run side
  by side, and a crashed instance never leaves the folder locked (#3100).
