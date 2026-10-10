### Fixed

- Settings → Plugins no longer overstates the native-plugin sandbox on Linux. The
  reduced-isolation warning for a system without Landlock no longer says "program
  limits still apply": it now says the home folder stays hidden where the namespace
  layer works, and otherwise that the plugin can read and change any of your files,
  startup scripts included. The "Your files" access chip now matches what the
  sandbox enforces: it notes that file names and sizes stay visible without the
  namespace layer, and is no longer shown as denied when reduced isolation leaves
  files reachable (#4605).
