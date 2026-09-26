### Fixed

- VNC and RDP sessions now honour the **Auto-Reconnect** setting. Previously
  the toggle did nothing and a dropped remote desktop always stopped at the
  manual reconnect prompt. With Auto-Reconnect on (the default), an unexpected
  drop retries up to 3 times (after 1 s, 2 s and 4 s), showing "Reconnecting…
  attempt n/3". The screen, cursor and window size come back once the server
  paints again. With it off, or once the retries are used up, the tab shows a
  **Connection lost** prompt with the reason and a Reconnect button. Rejected
  credentials, a server that keeps sending invalid frames, and your own
  disconnect or Cancel never trigger a retry. A wrong VNC password is now
  reported as an authentication failure (#3364).
