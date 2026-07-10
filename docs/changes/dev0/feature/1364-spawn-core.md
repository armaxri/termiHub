### Added

- New `termiHub spawn` command-line subcommand — the foundation for opening a
  session in termiHub from a terminal or (later) a file-manager context menu. It
  accepts `--location`, `--entry-id`, `--connection`, `--new-window`, `--pick`,
  `--container-image`, and `--container-mount`, builds a well-formed request, and
  forwards it over a per-user local IPC channel (a named pipe on Windows, a
  domain socket under the runtime dir on Unix) to an already-running termiHub. If
  no instance is running, the request is stashed and this launch handles it. The
  app stays multi-instance — the IPC channel is only a rendezvous. Actually
  opening the session, context-menu registration, and the picker land in
  follow-up work under epic #1363 (#1364).
