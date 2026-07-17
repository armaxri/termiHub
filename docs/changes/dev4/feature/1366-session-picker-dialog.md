### Added

- **Session Picker dialog** for shell-integration spawns. Invoking
  `termiHub spawn --pick …` (or a context-menu entry configured to ask) now opens
  an in-app picker in the focused window instead of spawning straight away. It
  shows the resolved host path and groups the machine's real targets into **Local
  shells**, **WSL**, **Docker** and **Podman** sections — enumerated live on every
  open via the new `list_spawn_options` command, so a section only appears when
  the host actually offers it (WSL on Windows only; a container runtime whose
  daemon is down drops out). Selecting a "New container…" row expands an inline
  image + mount form, defaulting to `ubuntu:22.04` bind-mounted at `/workspace`.
  "Open in new window" and "Remember choice" sit in the footer; cancel, ESC and
  the scrim all close the picker without spawning. Part of the shell-integration
  epic (#1363, SI-3, #1366).

### Changed

- A picked spawn target is now honored end to end: choosing a specific local
  shell opens _that_ shell rather than the system default, choosing a WSL
  distribution outranks the saved-connection and first-installed fallbacks, and
  choosing the Podman section runs Podman rather than auto-detecting (which
  preferred Docker on hosts with both). Spawns that make no explicit pick are
  unaffected and keep their previous defaults (#1366).
