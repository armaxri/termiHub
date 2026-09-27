### Fixed

- Editor: Monaco's background editor worker is no longer blocked by the app's
  Content-Security-Policy. It used to start from an inlined `data:` script that
  `script-src` refuses, so diff computation and link/word features ran without
  their worker. All Monaco workers now load as bundled files from the app
  itself (#3632).
