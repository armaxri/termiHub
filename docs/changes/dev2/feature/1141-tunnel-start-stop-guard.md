### Fixed

- Rapidly double-clicking Start or Stop on an SSH tunnel that is still
  connecting no longer fires a second backend call — the store now ignores a
  re-entrant start/stop for a tunnel whose previous call is still in flight.
  This removes the spurious "already active/connecting" error toasts and the
  brief Stop→Play→Stop state flicker. Addresses GAP 4 of the SSH tunnel audit
  (#1141).
