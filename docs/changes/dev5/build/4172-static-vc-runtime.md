### Changed

- Windows: the installers no longer need the Microsoft Visual C++ Redistributable.
  `termihub.exe` and the bundled RDP helper now link the Visual C++ runtime
  statically, so termiHub starts on a clean Windows 10/11 machine without a
  "VCRUNTIME140.dll was not found" error.
