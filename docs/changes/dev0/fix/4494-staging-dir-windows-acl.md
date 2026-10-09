### Security

- On Windows, the agent's update staging directory (`<config>/updates`) now
  carries a protected DACL granting only the current user and `LocalSystem`,
  inherited by the per-upload subdirectories inside it — the Windows analog of
  its Unix `0700` mode (#4494).
