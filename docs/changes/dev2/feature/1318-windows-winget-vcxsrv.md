### Changed

- Windows X11 setup now installs the local X server (**VcXsrv**) via **winget**
  instead of a bundled/downloaded build — symmetric to the macOS Homebrew path.
  When you enable X11 forwarding, termiHub runs
  `winget install -e --id marha.VcXsrv …` (with your consent), then manages the
  server. If winget (App Installer) isn't available, it guides you to install it
  from the Microsoft Store, with a manual VcXsrv download as a fallback — nothing
  is installed silently. Because winget (or you) fetches VcXsrv and termiHub only
  runs it as a separate process, termiHub no longer redistributes VcXsrv (#1318).
