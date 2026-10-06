### Changed

- Windows: the remote agent (`termihub-agent-windows-x64.exe` / `-arm64.exe`) now links the
  Visual C++ runtime statically, so an agent deployed over SSH starts on a minimal Windows host
  (Windows Server Core, a fresh VM) without the Microsoft Visual C++ Redistributable.
