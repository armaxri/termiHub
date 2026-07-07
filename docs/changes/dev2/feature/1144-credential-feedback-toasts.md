### Changed

- Credential store actions now confirm success or failure with a toast instead
  of resolving silently. Locking the store from the status-bar indicator shows a
  success toast (and a recoverable error toast on failure, replacing a silent
  console error); switching credential storage modes and changing the master
  password show success toasts, and a failed store switch surfaces an error
  toast. Wrong-current-password errors on the change dialog remain inline as
  before (#1144).
