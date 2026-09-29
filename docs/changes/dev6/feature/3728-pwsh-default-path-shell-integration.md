## Added

- Local shells can now use PowerShell 7 (`pwsh`), listed as "PowerShell 7" in the shell picker. On Windows the desktop now prefers PowerShell 7 as the default shell when it is installed, falling back to Windows PowerShell and then cmd — the same choice the agent makes. Existing connections saved with "PowerShell" keep using Windows PowerShell.

## Fixed

- Shell integration (working-directory tracking and prompt marks) now also works when a shell is given as an executable path, such as an agent default shell of `/bin/bash` or `C:\Program Files\PowerShell\7\pwsh.exe`. PowerShell paths also start with `-NoLogo`.
