### Fixed

- Network tools: closing a port scan or traceroute panel while the task was
  still starting no longer leaves the scan running in the background with no
  UI; the late-starting task is now cancelled. Backend event listeners that
  finished registering after their view had already closed are now removed
  instead of handling every later event a second time (#4375).
