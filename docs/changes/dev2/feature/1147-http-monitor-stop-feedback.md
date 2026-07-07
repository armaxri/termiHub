### Fixed

- HTTP monitor (Network Tools): stopping a monitor now shows a confirmation
  toast ("Monitor stopped") on success and an error toast on failure. Stopping
  a monitor previously gave no feedback — a successful stop was silent and a
  failed stop only set an inline error or a log entry. This applies to both the
  HTTP Monitor panel (the active monitor and the listed running monitors) and
  the Network Tools sidebar stop control. (#1147)
