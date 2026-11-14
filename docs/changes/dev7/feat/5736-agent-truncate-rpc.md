### Fixed

- An upload into an agent session that was interrupted by a crash now resumes
  from its last checkpoint after the relaunch. Before, it started over. The
  agent first cuts the bytes the remote file held past the checkpoint. This
  needs an agent of protocol 0.41.0 or newer, and a session opened after the
  agent was updated. With an older agent, or in an FTP session, the upload
  still starts over and the transfer row says why (#5736).
