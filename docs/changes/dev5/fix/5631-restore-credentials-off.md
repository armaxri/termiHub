### Fixed

- Restoring a backup while credential storage is off now says plainly that the credentials
  won't be restored, notes "Credentials will not be restored." beside the actions, and offers
  "Set up storage…" right in the restore dialog; once storage is set up, the credentials can be
  restored without leaving the dialog (#5631).
- The restore dialog's "Restore and restart" is a filled button again (red while a section is
  replaced) instead of a green outline, dialogs no longer draw a focus ring around their whole
  frame, and the replace warning and storage-off messages use sentence case and the option names
  from Settings ▸ Security (#5631).
