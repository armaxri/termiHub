### Changed

- **Large local folder copies now show up in the Transfer Queue.** Pasting or
  saving a local folder (including local ↔ WSL) copies its folders, symlinks and
  small files straight away and queues every file above 8 MiB as its own
  Transfer Queue row with progress, pause/resume, cancel and retry. Cancelling
  one of the folder's files cancels the rest, and a cancelled file never leaves
  a half-written copy behind. Copying into an existing folder merges into it,
  as before; copying a folder into itself, or a folder beyond 50,000 items,
  64 levels or 512 GiB, is refused before anything is written. Sockets, pipes
  and device files inside the folder are skipped and listed in a notice
  (#3605).
