### Fixed

- A VNC or RDP tab that is connected but still waiting for its first picture now
  heads "Waiting for the desktop…" instead of "Connecting to …", matching the
  steps shown below it, and offers **Abort** to stop waiting. While signing in,
  the connect screen says "Signing in to …" (#5836).
- The remote-desktop toolbar's **Disconnect** now ends the session and rests on
  the "Disconnected" screen; it used to reconnect straight away (#5836).

### Changed

- The remote-desktop toolbar shows itself for a few seconds once the desktop
  first paints, so its actions (Ctrl+Alt+Del, clipboard, scaling, fullscreen,
  disconnect) are seen before it hides behind hover. The scaling button names
  the active mode ("Fit to tab", "1:1 pixel", "Match window") and its tooltip
  says which mode a click switches to (#5836).
- The toolbar says where the keyboard goes: "Keyboard to remote" with the
  release chord while the desktop holds it, or "Keyboard to termiHub · click the
  desktop to type" otherwise. Hovering a desktop that does not hold the keyboard
  shows "Click the desktop to type into it" (#5836).
