### Fixed

- Portable mode: the application log (`termihub.log`), session transcripts and local crash
  reports are now written to `data/logs/` inside the portable folder instead of the host's
  profile, so a portable launch leaves nothing behind on the machine (#4065).
