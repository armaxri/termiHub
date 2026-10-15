### Fixed

- A loading toast is now always removed when its operation finishes, however
  fast. Installing a plugin from a file whose preview returned at once could
  leave "Validating plugin…" stuck over the install dialog's buttons, because
  the dismiss landed before the toast had appeared and was dropped. The fix sits
  in the shared toast helper, so every loading toast that wraps a quick backend
  call (plugin URL/index install, plugin update, file transfers, agent deploy)
  benefits (#4812).
