### Fixed

- Restored all app coloring after the production CSP regression: terminal ANSI
  colors and the xterm cursor now render again, and toasts once more appear as a
  fixed bottom-right corner overlay instead of flowing inline and consuming the
  lower app area. The restrictive production CSP (#2048) let Tauri append the
  `index.html` inline-`<style>` hash to `style-src`, which per CSP Level 3 makes
  the browser ignore `'unsafe-inline'` — silently blocking the runtime `<style>`
  elements that xterm (terminal colors/cursor) and sonner (toast overlay
  positioning) inject. Disabling Tauri's `style-src` modification keeps
  `'unsafe-inline'` effective for those runtime stylesheets while leaving
  `script-src` fully hardened (#2083, #2084, #2085).
