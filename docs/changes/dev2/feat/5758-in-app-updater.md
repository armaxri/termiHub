### Added

- Updates: termiHub can now update itself in place. Where a release carries the signed
  in-app updater (Windows MSI, macOS app, Linux AppImage), **Settings → Updates** and the
  update popup offer **Download and install**, which downloads the new version and verifies
  its signature, then **Restart to update**. Nothing installs without your click, and an
  older version is never installed. `.deb`/`.rpm` installs, portable copies and develop
  builds keep **Open downloads page**, with a hint where it helps (#5758).
