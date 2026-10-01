### Fixed

- WSL: opening a distribution that has never been launched no longer types termiHub's
  shell-integration `source …` line into the distribution's first-launch user setup
  (`Enter new UNIX username:`). termiHub now waits until a shell prompt is actually up
  before activating shell integration, leaves the setup prompts untouched, and enables
  CWD tracking once setup has finished (or in the next session).
