### Fixed

- Plugins: when the frontend plugin sandbox crashes repeatedly and is shut down,
  it now recovers on its own — after a short, growing delay it restarts and
  reloads your plugins, so protocol parsers and status-bar widgets come back
  without disabling and re-enabling them. A plugin that is identified as the
  cause of the crashes is disabled on its own while the others keep working;
  if the sandbox keeps crashing it stops retrying after a few attempts and the
  Log Viewer names the suspect plugin(s). Terminal output keeps flowing
  untransformed throughout (#2857).
