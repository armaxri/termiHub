### Fixed

- Terminal (Windows): Ctrl+C now interrupts the running program in a local shell
  or WSL tab even when termiHub was started by a launcher that disables Ctrl+C
  for its children (a CI runner, a service wrapper, a script host started with
  `CREATE_NEW_PROCESS_GROUP`). Windows hands that "ignore Ctrl+C" attribute down
  to every child process, so the shell termiHub hosted ignored the interrupt;
  termiHub now clears it before it starts a shell (#4981).
