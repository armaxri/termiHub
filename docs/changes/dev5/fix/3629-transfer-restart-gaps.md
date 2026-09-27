### Fixed

- Files dragged out of a remote file browser no longer come back as paused
  Transfer Queue rows after a restart. Their staging downloads are no longer
  kept across restarts (#3629).
- A folder paste into or between sessions that was interrupted by quitting
  termiHub is no longer left half-copied without a word. On the next launch a
  notice says the paste did not finish, and its Retry copies only the files
  that are still missing once the connection is open again (#3630).
