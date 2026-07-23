### Added

- Local shell connections now support **per-connection environment variables**.
  A new **Environment** section in the local shell connection settings lets you
  define `NAME`/value pairs that are applied on top of the inherited environment
  when the terminal's shell is spawned — a connection env var overrides any
  inherited value of the same name. Values support `${VAR}` expansion against the
  launching process's environment (e.g. `${HOME}/bin`). Docker connections already
  had container env vars; SSH and WSL are tracked as a follow-up (their remote/
  distribution env handling differs — SSH needs `SetEnv`/`AcceptEnv`, WSL needs
  `WSLENV`) (#1825).
