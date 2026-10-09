### Fixed

- SSH sessions to a PowerShell host with shell integration or configured
  environment variables no longer occasionally run the first command before the
  session setup: termiHub now types the setup only once PowerShell shows its
  first prompt, and holds your input until the setup has reported back (the
  shell-integration prompt mark), so the first command always sees the
  configured environment (#4604).
