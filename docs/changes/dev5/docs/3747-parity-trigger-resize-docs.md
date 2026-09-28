### Added

- Documented the workflow control-flow steps in the README: `conditional`, `loop` and
  `wait-for-output`, with their limits (1000 loop iterations, 10 nesting levels, 30 s default /
  10 min maximum output wait).
- Documented the workflow trigger scope for 0.1: manual, hotkey and on-connect only. There are no
  on-disconnect or on-output-match triggers; time-based runs are Schedules, not a trigger.
- Added a desktop-vs-remote-agent connection-type table to the README. The agent hosts local
  shell, SSH, serial, telnet, Docker, WSL (Windows agents) and FTP, but not RDP / VNC or plugin
  connection types.
- Documented that resizing a serial tab does not tell the device the new size, and how to set it
  on the device instead.
