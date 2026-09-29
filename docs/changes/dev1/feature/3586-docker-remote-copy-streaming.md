### Changed

- Copying or moving a file between two sessions now streams it as one tracked transfer whenever
  each side is an SSH (SFTP) or Docker session — including Docker to Docker, SFTP to Docker and
  Docker to SFTP (#3586). The copy shows progress in the Transfer Queue and can be paused,
  resumed, retried and cancelled; it no longer loads the whole file into memory first. After an
  app restart it resumes from where it stopped, re-attaching each Docker side to the same
  container. Copies involving an FTP or remote-agent session still use the previous direct
  read/write.
