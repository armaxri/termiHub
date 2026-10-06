### Changed

- Copying a file between an agent-hosted session and another session (or
  between two agent-hosted sessions) now runs as one queued transfer with
  progress, pause/resume, retry and cancel, streamed in 256 KiB slices
  instead of loading the whole file into memory (#4115). It needs an agent
  that supports ranged file access; older agents keep the previous
  whole-file copy. Such a copy also resumes after termiHub restarts once the
  agent is reconnected.
