### Changed

- The Recent Sessions "Save as Connection" dialog is now a full promotion
  editor. Alongside name and folder it exposes an icon picker and editable
  connection fields (host/port/username and, for SSH, the auth method)
  pre-filled from the history entry, plus a "Save password to credential store"
  checkbox. When ticked and a password is entered, the secret is written to the
  credential store before the connection is saved; the checkbox is disabled when
  no credential store is configured (#1932).
