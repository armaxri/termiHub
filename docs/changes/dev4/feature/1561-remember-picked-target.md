### Added

- **"Remember this choice" now persists.** The Session Picker's footer checkbox
  previously rendered and reached the confirm payload but saved nothing. Ticking
  it now writes the picked target onto the context-menu entry that triggered the
  spawn, for **every** section the picker offers — a local shell, a WSL
  distribution, or a Docker/Podman "new container" with its image and mount. The
  next right-click on that entry opens the remembered target directly instead of
  asking again. A spawn started from a bare `termiHub spawn --pick` has no entry
  to remember onto, so the box is simply a no-op there (#1561).

### Fixed

- **A context-menu entry can now actually spawn a container.** Registration used
  to emit only `spawn --entry-id <id> --location <path>`, so a click arrived with
  no spawn kind and was inferred to be a local shell. The saved per-entry
  container image (#1447) was therefore only ever consulted when the CLI passed
  `--kind container` explicitly — an entry configured with an image silently
  opened a shell instead. The registered command line now carries the entry's
  remembered kind, and the spawn resolvers fall back to the entry's saved shell
  and container runtime when the request names none (#1561).

### Changed

- `ShellEntry` gained `spawnKind`, `shell` and `containerRuntime`. All three
  default, so existing `settings.json` files load and round-trip unchanged and
  read as "no remembered choice" — which preserves every previous spawn
  behaviour. A WSL distribution is stored in the existing `wsl:<distro>` shell
  encoding rather than as a second representation (#1561).
