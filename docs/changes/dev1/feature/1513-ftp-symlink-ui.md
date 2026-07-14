### Added

- File browser symbolic-link support: symlinks now render with a distinct
  link-badge icon, can be followed on double-click / Enter (resolving the link
  target, including relative targets against the link's directory), and show
  their target inline after the name as a `→ target` hint (with a hover title).
  The shared file model carries new `isSymlink` / `symlinkTarget` fields,
  populated from the FTP listing parser (Unix `ls -l` `-> target` and MLSD
  `type=link`) and the local and SFTP browsers where the information is cheaply
  available. Closes #1513.
