### Fixed

- Terminal flow control now also covers sessions running on a remote agent. When
  a program on the agent host floods the terminal (`yes`, `cat` of a huge log),
  termiHub asks the agent to stop reading that session's output until the
  terminal catches up, so the remote program is slowed down instead of output
  piling up — and none of it is dropped any more. Ctrl+C and your other sessions
  on the same agent keep responding. Persistent sessions are covered too. This
  needs an updated agent; with an older agent the terminal keeps its previous
  safety limit.
