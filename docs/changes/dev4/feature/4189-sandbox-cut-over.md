### Security

- **Native plugins now always run in their own sandboxed process.** termiHub no
  longer loads a native plugin backend into its own process: every enabled native
  plugin runs in a separate `termihub-plugin-runner` process confined by the
  operating system (landlock + seccomp on Linux, Seatbelt on macOS, a
  Less-Privileged AppContainer on Windows). A plugin can read its install folder
  and read and write its private data folder, and nothing else; it cannot read
  your files or credentials, open network connections of its own, or start
  programs. If full isolation is unavailable, the plugin loads only after you
  accept reduced isolation for that exact build; if the sandbox cannot start, the
  plugin does not load. There is no setting to run a plugin without the sandbox.
  Native plugins stay off by default and still need your per-plugin trust
  (SEC-002, #3769, #4189).

### Changed

- Plugin authors: a native backend needs no rebuild and the plugin ABI is
  unchanged, but direct file access outside the plugin's data folder and direct
  network sockets now fail with a permission error (use the capability bridge),
  starting processes is not allowed, and `HOME` / `TMPDIR` point into the data
  folder. See "The plugin sandbox" in `docs/plugin-authoring.md` (#4189).
