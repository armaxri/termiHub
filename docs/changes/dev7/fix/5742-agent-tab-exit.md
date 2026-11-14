### Fixed

- Typing `exit` in a shell running on a termiHub remote agent now ends the tab with
  "[Process exited with code N]", like a local shell, instead of leaving the tab open with a dead
  session. The tab is not reconnected: a shell you ended stays ended, while a lost agent link
  still reconnects. Needs an updated agent (protocol 0.39.0); with an older agent the session
  behaves as before (#5742).
