### Added

- **Linux: exporting credentials from the OS keychain now works** in the `.deb`
  and `.rpm` packages. termiHub ships a polkit action
  (`com.termihub.app.reauthenticate`) and asks your desktop's polkit agent for
  **your own account password** before every vault export or backup that
  includes credentials — nothing is remembered between exports. AppImage and
  portable builds cannot install the action, so there the export stays blocked
  with a clear reason (switch to Master Password storage to export). (#3535)
