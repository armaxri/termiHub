### Fixed

- X11 forwarding: the "Stop X Server When Idle" setting now works. With it on, the managed X
  server shuts down 30 seconds after the last X11-forwarding session closes (a new session in
  that window keeps it running); with it off, the server stays up until termiHub exits.
  Changing the setting takes effect immediately, without a restart (#4326).
