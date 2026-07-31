### Fixed

- SFTP file browsing now reaches jump-host (`ProxyJump`) targets. The desktop
  SFTP file browser previously connected directly and ignored the configured
  jump-host chain, so browsing a host only reachable through a bastion failed;
  it now connects through the pooled gateway like every other SSH provider
  (#939, part of #2104).
