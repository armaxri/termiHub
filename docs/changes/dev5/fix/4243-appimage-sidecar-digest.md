### Fixed

- Linux AppImage: RDP sessions and native plugins no longer fail with a
  "tampered" error. The AppImage bundler rewrote the bundled RDP helper and
  plugin runner after their integrity digests were recorded, so the app refused
  to start them. They now ship byte-identical in the AppImage, `.deb` and `.rpm`,
  and the build checks every Linux package for this (#4243).
