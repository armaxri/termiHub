### Fixed

- The file browser now follows the working directory of PowerShell sessions on
  Windows. CWD-following relies on the shell emitting OSC 7 (`file://` URI);
  PowerShell previously emitted only OSC 9;9, which updated the terminal's CWD
  state but not the file browser, so folder-following silently did nothing on
  the default Windows shell. termiHub now overrides the PowerShell `prompt`
  function to emit OSC 7 (backslashes converted to forward slashes, path
  URL-encoded, hostname as authority) for both Windows PowerShell 5
  (`powershell.exe`) and PowerShell 7 (`pwsh`), while preserving any
  profile-defined prompt (#2676).
