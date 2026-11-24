### Changed

- SSH: when a server's host key changed, the dialog now makes the old and the new key easy to
  tell apart. Both fingerprints are shown in aligned groups of four characters, each with a small
  block pattern drawn from it (two different keys give two visibly different patterns), and the
  dialog says in words what changed: the fingerprint, and whether the key type is the same. The
  copy button beside the new key reads "Copy new fingerprint".
- SSH and RDP: the host-key and certificate trust dialogs now name the connection you opened,
  not only its host and port, so with several connections to one host you know which one asks.
