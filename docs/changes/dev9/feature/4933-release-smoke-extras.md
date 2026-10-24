### Changed

- Content-Security-Policy violations are now written to the application log
  (`termihub.log`) as warnings, so a resource the shipped CSP blocks shows up in
  the log a bug report attaches (#4933).

### Internal

- The release install smokes now grade the app icon, single-instance and
  portable double-launch behaviour, the production CSP, the macOS Gatekeeper /
  quarantine path of the unsigned beta and the Windows Start menu shortcut on
  the shipped artifacts; the matching guided-manual checks (MT-APP-02,
  MT-APP-04, MT-UI-19) were retired (#4933).
