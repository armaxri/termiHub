### Fixed

- RDP: keyboard and mouse input now reaches servers that do not accept fast-path
  input (such as VirtualBox VRDP), which could otherwise close the connection as
  soon as you typed or moved the mouse. termiHub now checks which input format
  the server advertises when connecting and after every resolution change, and
  falls back to the standard input format when fast-path input is not offered
  (#5138).
