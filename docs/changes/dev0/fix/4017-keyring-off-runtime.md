### Fixed

- Linux: changing the master password, switching the credential store, and
  resetting it no longer hang at "Changing…". The system keyring (Secret
  Service) call they make panicked when it ran on a background task (#4017).
