### Fixed

- A daemon-backed session (local shell, SSH, Docker, serial hosted by the agent)
  no longer hangs indefinitely when the session-daemon peer wedges partway
  through sending a frame. The steady-state read loops on both the client and the
  daemon now apply a mid-frame read timeout: once a frame has begun arriving, its
  remaining bytes must arrive within a bounded window, so a peer that stalls
  mid-frame fails the session and the normal reconnect/redrive path takes over
  instead of the terminal appearing frozen (part of #3015, AGT-023 follow-up).
  A legitimately idle-but-alive session (a shell parked at a prompt with no
  output) is never affected — the wait for a frame's first byte stays unbounded.
