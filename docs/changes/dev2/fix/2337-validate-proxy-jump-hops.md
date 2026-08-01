# Changes

## Fixed

- **SSH jump hosts**: a misconfigured `ProxyJump` bastion is now rejected before
  connecting, with an error that names the offending hop
  (e.g. `jump host 2 (bastion:22): SSH host must not be empty`). Previously only
  the target connection was validated, so a hop with an empty host/username — or
  a key-auth hop with no key selected, which silently fell back to
  `~/.ssh/id_rsa` — slipped past validation and failed later with a confusing
  low-level connect/auth error mid-chain.
