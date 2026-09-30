### Security

- The SSH and RDP trust stores (`ssh_known_hosts.json`, `rdp_known_hosts.json`)
  are now downgrade-safe and recover from corruption without losing trust
  decisions (#2745). Their format version is recorded in a sidecar file
  (`<file>.version`) so the store files stay readable by every earlier build. A
  store written by a newer termiHub is left untouched and never overwritten,
  and its entries are not used, so nothing is trusted on a guess. A corrupt
  store is backed up first (earlier backups are never overwritten), then every
  valid host and key is kept and only the invalid parts are dropped. If the
  backup cannot be made, the store is not overwritten. Each of these cases is
  shown in the startup recovery notice instead of silently starting empty.
