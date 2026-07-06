### Fixed

- SFTP file transfers no longer fail silently. Downloading, uploading (toolbar
  button or dropping a file onto the browser), and pasting into an SFTP location
  now show a pending toast that resolves into a success confirmation or a
  persistent error carrying the backend's message. Previously a failed transfer
  gave no feedback at all — the file simply was not there. A multi-item paste now
  stops on the first failure instead of clearing a cut clipboard on a partial
  paste (audit gap D2, #1143).
