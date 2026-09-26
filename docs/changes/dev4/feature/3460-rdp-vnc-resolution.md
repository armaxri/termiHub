### Added

- RDP connections can now pin the remote desktop to a **fixed resolution**: the
  editor's Display group has a **Resolution** select (_Dynamic (follow window)_,
  the default and previous behavior, or _Fixed size_) with **Width** / **Height**
  inputs (200–8192 px; odd widths are rounded down to even). A fixed session never
  asks the server to resize — the tab scales it locally and the scaling button
  toggles only between _Fit to Tab_ and _1:1 Pixel_ — and an auto-reconnect comes
  back at the same size (#3460, audit PROD-026).

### Changed

- The RDP **Color Depth** select now offers only the depths the RDP client
  actually negotiates and decodes (32-, 24- and 16-bit); 24-bit is now honored
  instead of silently falling back to 32-bit. A saved 8-bit choice connects at
  32-bit as before (#3460).
- VNC connections no longer show a **Color Depth** select: VNC sessions always
  run at 32-bit color, so the option had no effect. The status bar no longer
  shows a color depth for VNC tabs either. A working VNC color depth and
  VNC fixed resolution are tracked in #3464 and #3463 (#3460).
