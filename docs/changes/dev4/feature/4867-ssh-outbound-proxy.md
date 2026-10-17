### Added

- SSH connections can now go out through a **proxy** (#4867): a new collapsed
  _Proxy_ settings group offers SOCKS5, SOCKS4/SOCKS4a and HTTP (`CONNECT`)
  proxies with an optional user and password, like OpenSSH's
  `ProxyCommand nc -X`. The proxy password is kept in the credential store,
  never in the connection file. The server's host key is still checked against
  the SSH host, not the proxy. With jump hosts, only the connection to the first
  jump host goes through the proxy. A wrong proxy password, a proxy that refuses
  the connection, or a malformed proxy reply fails the connect with a clear
  error.
- The MobaXterm importer maps an SSH session's SOCKS4, SOCKS5 and HTTP proxy
  onto the new proxy setting instead of only listing it as a preview note. The
  proxy password is not imported; enter it in the connection's Proxy settings.
