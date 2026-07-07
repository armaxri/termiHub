# HTTP monitor start double-fire guard

## Fixed

- HTTP Monitor: rapidly double-clicking **Start** (or clicking again while a
  start was still in flight) no longer spawns two independent backend monitors
  for the same URL. Only one monitor starts per Start action; the previously
  untracked duplicate poller can no longer be created. (#1147, GAP #7)
