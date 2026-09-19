### Changed

- The built-in **dark theme** now uses the modern design-system palette
  (`#0f1117` background / `#3d7de8` accent) instead of the legacy classic
  VS-Code values (`#1e1e1e` / `#007acc`), reconciling the app with the
  ui-modernization design system (`docs/concepts/implemented/ui-modernization.html`,
  the source of truth). Surface, accent, text, border and state tokens now match
  `src/styles/variables.css`; terminal ANSI colors keep their terminal-standard
  hues but sit coherently on the darker base. The light theme is unchanged.
