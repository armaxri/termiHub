### Changed

- Password prompts: every password prompt now names the connection or agent it is for in
  its title, including agent connect, agent setup and update, Test Connection and Save &
  Connect in the editor, remote-desktop (VNC/RDP) passwords, connection field secrets and
  a VNC connection's linked SSH file route — so with several prompts queued you can tell
  which one you are answering (#4475).

### Fixed

- Password prompts: the "Save password" choice is now kept per prompt, so answering one
  queued prompt can no longer decide whether another connection's password is saved
  (#4474).
