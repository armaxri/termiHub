### Changed

- File servers are the same in every window at once: a new one, an edit, a
  delete, the state and the traffic. Before, a save in one window did not reach
  the others (#6028).
- The kinds of file server say what they are for, in the dialog and in the row's
  tooltip: open a folder in a browser (HTTP), upload and download files (FTP),
  give files to a device (TFTP) (#6028, #6036).

### Fixed

- A file server that could not start, for example because its port is in use,
  keeps its red state and the reason until you start, stop or change it. Before,
  only a message said so and the row read "Stopped" (#6028).
