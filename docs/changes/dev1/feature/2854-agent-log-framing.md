### Changed

- Remote agent log messages now appear in the Log Viewer and `termihub.log` at their real level
  (error, warning, info, debug) and with the agent module that wrote them. Before, every agent
  message showed up as a desktop warning. Each message also carries the session's correlation id,
  so you can match agent messages to the desktop's own log lines for the same session. (#2854)
