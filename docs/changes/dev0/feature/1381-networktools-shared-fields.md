### Changed

- Network Tools panels: every text input (Ping / Traceroute / Port Scanner
  host, DNS hostname + server, Wake-on-LAN MAC, Port Scanner ports) now shares
  the same label + input + inline-error affordance as the numeric fields. The
  Run/Send button stays disabled while a field is invalid, and obviously-invalid
  input — an empty host/hostname, a malformed MAC, or an empty port list — is
  flagged inline as soon as you engage the field instead of only greying the
  button (#1381).
