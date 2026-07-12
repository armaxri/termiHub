### Changed

- The **Shell Integration** settings now show the file managers actually
  detected on the host instead of an empty list (#1397). On Linux, the Nautilus,
  KDE (Dolphin) and Thunar rows annotate each enabled toggle with whether the
  manager was detected and, where available, its version (parsed from the
  manager's `--version` output) — e.g. "detected: Nautilus 43.2". On macOS and
  Windows the native always-present manager (Finder / File Explorer) is reported.
