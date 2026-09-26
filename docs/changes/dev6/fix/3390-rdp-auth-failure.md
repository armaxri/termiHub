### Fixed

- A rejected RDP password now shows **Authentication failed** instead of
  retrying. Before, RDP checked the credentials after the connection had
  already started, so a rejection looked like an ordinary drop: with
  Auto-Reconnect on it used up all 3 retries and ended as "Connection lost".
  termiHub now tells a credential rejection (NLA/CredSSP logon failure, or a
  server logon/privilege error) apart from a network failure. A rejection
  never triggers a retry, whether it happens on the first connect or on a
  reconnect. An RDP host that cannot be reached on the first connect now
  shows the connect-failed overlay instead of retrying (#3390).
- A wrong password on the first VNC connect now shows the "Authentication
  failed" overlay ("Check the credentials") instead of the generic connect
  error (#3390).
