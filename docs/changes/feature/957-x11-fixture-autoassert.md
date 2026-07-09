### Fixed

- Terminal: the tab menu's "Copy to Clipboard" and the copy-selection shortcut no longer
  silently do nothing when the app window isn't focused. The terminal copy paths used the
  web clipboard API (`navigator.clipboard.writeText`), which rejects on macOS/WKWebView
  when the document is unfocused; they now use the OS clipboard like paste and the rest of
  the app (#957).
