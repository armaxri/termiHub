### Changed

- Remote desktop (VNC/RDP) tabs now follow the same one-window-in-control rule as
  terminals. When another termiHub window takes a remote desktop over, the previous
  window shows **"Taken over by another window"** with a **Reclaim** button over a
  dimmed, frozen picture; its keyboard, mouse, resizing and clipboard (both
  directions) are ignored, enforced by the app backend too. Nothing takes control
  back on its own. After reclaiming, the window restores its screen size and
  repaints the desktop at once.
