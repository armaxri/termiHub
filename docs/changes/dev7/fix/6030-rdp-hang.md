### Fixed

- Remote Desktop: closing a tab, typing, resizing and the clipboard no longer freeze when the RDP helper stops responding; they report it, and closing ends the helper (#6030).
- Remote Desktop: a clipboard file that the server never sends fails after a minute instead of waiting forever, and no longer blocks the files after it (#6030).
- Remote Desktop: a server that asks for the clipboard before its clipboard channel is ready no longer ends the session, and one that never finishes a resize no longer freezes it (#6030).
