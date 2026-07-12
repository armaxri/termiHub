### Fixed

- macOS app-level **"Open in termiHub"** Services-menu entry now works (#1409).
  #1369 declared the app-level `NSServices` entry in the app bundle, but an
  app-provided macOS Service needs a native Cocoa provider registered on
  `NSApp.servicesProvider` implementing the `openInTermiHub` selector — without
  it the entry was inert. termiHub now registers that provider at startup: it
  reads the selected file/folder paths off the pasteboard and opens a session at
  each, reusing the same spawn flow as the per-entry Automator Quick Action
  bundles. macOS-only; Windows and Linux are unaffected.
