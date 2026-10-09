### Fixed

- A program that floods the terminal with output (`yes`, `cat` of a huge log, a
  chatty build) no longer makes termiHub's memory grow without bound or the UI
  freeze. The terminal now applies flow control: when it falls behind rendering,
  termiHub stops reading the program's output until the terminal catches up, so
  the program itself is slowed down instead of the output piling up in memory.
  No output is lost, and Ctrl+C still reaches the program straight away. This
  applies to local shells and direct SSH, serial, telnet and Docker sessions.
  Sessions running on a remote agent are not slowed down yet; for those the
  terminal's pending output is capped at 32 MiB instead of growing forever.
