### Fixed

- Recovering a corrupt configuration file no longer discards every entry in it.
  If the embedded servers, session history, workspaces, workflows, tunnels, or
  macros file has a single unreadable entry, termiHub now backs the file up to
  `.bak` and drops **only** the corrupt entry (with a warning naming its index),
  keeping all of the other saved entries — mirroring the connections store's
  existing per-entry recovery. A whole-store reset now happens only when even the
  file's container is unparseable (PER-004).
