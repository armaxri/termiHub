### Added

- **SSH** and **WSL** connections now support **per-connection environment
  variables**, completing the follow-up to #1825 (which added them for local
  shells). Both connection editors gain an **Environment Variables** key/value
  field (#1841).
  - **SSH**: variables are requested over the SSH channel (`set_env`) **and**,
    for reliability, exported in the remote interactive shell once it starts.
    The channel request is only honoured for names the server whitelists in its
    sshd `AcceptEnv` setting (which usually accepts little beyond `LANG`/`LC_*`),
    so the `export` fallback guarantees the variables take effect regardless — at
    the cost of being briefly visible in the terminal at connect time.
  - **WSL**: variables are set in the Win32 environment of `wsl.exe` and shared
    into the Linux side by adding their names to `WSLENV` (any pre-existing
    `WSLENV` is preserved). Values cross verbatim, with no path translation.
