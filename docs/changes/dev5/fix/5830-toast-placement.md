### Fixed

- Toasts no longer cover form fields or the status bar (#5830). The toast stack now always
  starts above the status bar, so the credential lock indicator stays visible. While the
  connection, workspace or tunnel editor is open, a toast shows as one compact line at the top
  right, above the form, instead of over the fields you are filling in. Opening a dialog
  dismisses the success messages still showing, so old feedback never sits next to a new
  decision. Confirmations of actions taken inside a dialog show in the dialog's own status
  line instead of a toast beside it.
