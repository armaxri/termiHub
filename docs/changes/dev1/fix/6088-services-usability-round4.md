### Changed

- A new file server or tunnel gets a port that none of your other services uses. A port another one uses
  is said with its name, and a free one is offered (#6088).
- A TFTP server says that devices usually ask on port 69, and what opening that port needs (#6088).
- New tunnels reconnect when the connection drops, as connections do. Saved tunnels keep their setting
  (#6088).
- An offline agent whose services wait to be stopped says so once, with **Keep all running** (#6088).
- A SOCKS5 proxy says how to set a browser to it (#6088).
- A remote and a dynamic tunnel without a name are called by what they are for (#6088).
- A server or tunnel on one address says who reaches that address, a password is said to go unencrypted,
  and "Download only" is one word everywhere (#6088).
- An address breaks after its scheme or a dot, never before its port (#6088).
