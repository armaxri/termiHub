### Fixed

- RDP connections to servers without Network Level Authentication (for example
  xrdp on Linux) now log in with the saved username and password instead of
  stopping at the server's own login screen. The RDP helper now asks the server
  to log on automatically whenever a password is set, as the Windows client does.
- When an RDP server ends the session itself (a logoff, a rejected logon, or the
  server closing the connection), the tab now notices right away. Previously the
  RDP helper process kept running after the connection had closed, so the tab
  stayed open without reporting that the session had ended.

### Internal

- Added an automated RDP integration suite (`core/tests/rdp.rs`) against a new
  `rdp-server` Docker fixture (xrdp plus a FreeRDP NLA server). It runs on the
  nightly Docker-fixture lane and drives the real RDP helper. It covers logon and
  rendering, fixed resolution, wrong passwords, the clipboard, the certificate
  prompt, and a check that no helper process is left running (#3609).
