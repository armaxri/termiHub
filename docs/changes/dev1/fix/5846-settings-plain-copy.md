### Changed

- Settings ▸ General: the **File browser** default now says it shows the file browser for SSH
  connections (not "SSH agent sessions"), and its "?" explains that turning it off only closes
  the file browser of open sessions; their terminals stay connected (#5846).
- Settings ▸ Terminal ▸ Command marks: the hint names the shells it works with (bash, zsh, fish
  and PowerShell, once the shell hook is on); the protocol name is only in the "?" help (#5846).
- Settings ▸ Updates: automatic update checks are one **Check for updates automatically**
  toggle instead of two "On startup" / "Never" cards. It stays on by default (#5846).
- Settings ▸ General and Terminal: long hints are one short line, with the details behind the
  "?" beside the label (part of #5900).
