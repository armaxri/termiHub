### Added

- In a local shell on macOS and Linux, termiHub now tells from the terminal itself when a program
  reads with its echo off, so a recording leaves out what is typed at an unusual prompt such as
  "Enter code:", and an automation that waits for you does not go on past it. Elsewhere (SSH,
  telnet, serial, agent sessions, Windows) the prompt's words still decide, as before. (#6014)
