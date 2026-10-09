### Fixed

- When an RDP server ends your session on purpose — you log off inside the remote
  desktop, an administrator disconnects or logs you off, a session time limit
  expires, or another client takes the session over — the remote-desktop tab now
  shows "Session ended by the server" with the server's reason and a Reconnect
  button. Before, termiHub treated this like a lost network connection and
  automatically reconnected, which could log you straight back in. Network drops
  and server restarts are still reconnected automatically, within the usual 10
  attempts, and a tab you stopped is never reconnected (#4321).
- When an RDP session ends because the server sent data termiHub can't process,
  or a display reconfiguration (for example after a resize) fails, the tab now
  shows the reason instead of a generic "Connection lost", and does not reconnect
  into the same error; the Reconnect button still works (#4509).
