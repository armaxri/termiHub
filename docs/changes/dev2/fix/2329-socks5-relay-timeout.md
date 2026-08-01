### Fixed

- Tunnels: dynamic (`ssh -D`, SOCKS5) port forwards no longer drop every proxied
  connection after 10 seconds. The SOCKS5 handshake timeout mistakenly wrapped the
  whole session (handshake **and** relay), so any longer-lived connection — a
  download, a persistent stream, SSH-over-SOCKS — was force-closed once the window
  elapsed. The timeout now bounds only the negotiation; an established relay runs for
  as long as the client needs it (#2329).
