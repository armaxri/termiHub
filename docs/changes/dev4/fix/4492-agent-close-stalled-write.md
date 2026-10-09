### Fixed

- Remote agent: closing a terminal whose program stopped reading its input (or a
  telnet peer that stopped reading) no longer hangs until the stuck write
  returns. The session closes at once and its connection is shut down as soon
  as the write gives up (#4492).
