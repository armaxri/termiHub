### Fixed

- Launching termiHub again with `--workspace <name>` or `--workspace-file <file>`
  while it is already running now opens that workspace in the running window,
  instead of only focusing it and dropping the arguments. Unknown arguments are
  ignored and logged (#3101).
