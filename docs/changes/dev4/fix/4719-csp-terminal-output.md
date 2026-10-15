### Fixed

- A telnet server's greeting, or a shell's first prompt, sent the instant a
  session connects is no longer lost. Output that arrived before the terminal
  started listening was dropped, so a server that writes on connect could leave
  the terminal blank. This affected telnet, local shell, serial, SSH and WSL
  sessions (#4719).
