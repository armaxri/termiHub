### Security

- Tightened the app's Content-Security-Policy: stylesheets the app creates at
  runtime (terminal, editor, toasts, dialogs, color picker) are now allowed by a
  per-launch nonce instead of a blanket `style-src 'unsafe-inline'`, so injected
  `<style>` markup is blocked. Only inline style attributes keep
  `'unsafe-inline'`, via `style-src-attr` (#3115).
