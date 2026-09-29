### Fixed

- Pasting a large block of text into a session on a remote agent, or streaming a
  graphical session through an agent, no longer lets the desktop's memory grow
  without limit when the agent link is slow. Input now waits for the link to
  catch up, so nothing is lost. Disconnecting or closing a session still takes
  effect at once, even while a large paste is being sent.
