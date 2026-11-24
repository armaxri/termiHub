### Changed

- Canceling the password prompt of a VNC/RDP connection saved under an agent, or of an SSH shell
  opened from the file manager or CLI, now says which connect stopped ("Connect to "Build server"
  canceled.") and offers Retry, instead of a bare "Connect canceled". After a canceled unlock, the
  spawned shell offers "Type password instead", which keeps the credential store locked and asks
  for the password (#5881).
