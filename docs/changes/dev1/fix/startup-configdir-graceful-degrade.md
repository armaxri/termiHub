### Fixed

- Launch now tells you when it had to fall back to temporary storage because
  the config or portable data directory could not be created. Startup already
  degraded to a temp directory instead of crashing (on read-only portable
  media, a locked-down profile, a full disk, or a config path that is a file),
  but it only wrote a log line the user never sees, so temporary storage looked
  like normal operation until settings and credentials failed to persist. Each
  such degradation now surfaces as a startup recovery warning, the same way a
  recovered `connections.json` or `settings.json` does.
