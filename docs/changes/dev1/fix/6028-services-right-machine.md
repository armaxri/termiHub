### Changed

- File servers remember where they run (#6028). **Run on** is saved with the server, and the row's
  tooltip says it. Earlier versions forgot the choice when termiHub closed and ran the server on
  this computer after that. If you had set a file server to an agent, choose the agent once more.
- A file server or SSH tunnel that belongs on an agent is started there or not at all (#6028). When
  the agent is offline, removed or too old, or the saved machine cannot be read, nothing is opened on
  this computer and the row says why.
- Moving a running file server or tunnel to another machine stops it where it ran (#6028).
- Duplicating a file server that asks for a password opens the copy in the editor, because a copy
  does not get the password. Duplicating a tunnel no longer copies its chain or "start with
  connection" (#6028).

### Fixed

- A copy of a file server keeps the machine it runs on (#6028).
- SSH tunnels: a tunnel with a machine written by a newer version is kept instead of removed as
  corrupt, and saving a tunnel keeps fields a newer version added (#6028).
- SSH tunnels: a tunnel moved to an agent while it was reconnecting no longer opens on this computer
  (#6028).
- Portable mode copies the file servers too (#6028).
