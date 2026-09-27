### Fixed

- Saved passwords and key passphrases are now kept separately per connection
  file. A connection in the main store and a same-named connection in an
  external connection file no longer share, overwrite or delete each other's
  saved secret, and moving a connection between files takes its saved secret
  along (#3591).
- Renaming or moving an external connection file keeps its connections' saved
  secrets: termiHub stores a file id in the file (`"fileId"`) the first time it
  sees it.
- Secrets saved before this change are copied to their connection file on the
  first start (or unlock) after updating. Where two connections shared one saved
  secret, both keep it, and a one-time notice lists them so a password that
  belonged to the other connection can be entered again.
