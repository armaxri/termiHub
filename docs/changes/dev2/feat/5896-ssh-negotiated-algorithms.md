### Added

- Status bar: the SSH chip's "Connection security" popover now names what the
  session actually negotiated: the encryption cipher (e.g.
  "chacha20-poly1305"), the integrity MAC when the cipher needs one, the key
  exchange (e.g. "curve25519-sha256") and the host key algorithm. This works
  for direct and agent-hosted SSH sessions; with an older remote agent the
  popover still says "Encrypted (SSH)". The chip itself is unchanged.
- Remote agent protocol 0.43.0: `connection.sshAlgorithms` reports the
  negotiated algorithms of an agent-hosted SSH session.
