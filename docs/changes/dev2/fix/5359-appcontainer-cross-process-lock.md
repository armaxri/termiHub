### Fixed

- Plugins (Windows): two termiHub instances running side by side (for example
  the installed app and a portable copy) could race while setting up a native
  plugin's sandbox. Creating the plugin's AppContainer profile failed with
  `0x8000ffff`, a runner failed to start with "file not found", or a sandbox
  permission on the runner was lost. Profile and permission changes are now
  serialised across every termiHub process of the session (#5359).
