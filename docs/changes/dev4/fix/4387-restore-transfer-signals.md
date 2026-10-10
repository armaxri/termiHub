### Fixed

- Session restore: auto-save now waits until every restored tab has connected
  or failed, instead of resuming after a fixed two seconds. A restore with slow
  SSH or agent connections no longer overwrites the saved session with tabs
  that are still connecting (#4387).
- Transfer Queue: a transfer that finished and was removed from the queue
  before it appeared there can no longer come back as a row stuck at "queued".
  The app also no longer polls the backend every few seconds while transfers
  are running (#4387).
