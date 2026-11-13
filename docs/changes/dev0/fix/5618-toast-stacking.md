### Fixed

- Toasts no longer overlap: several toasts now stack one above the other with a
  gap, so an older toast's text never shows through a newer one (#5618).
- A connection's "Connected" toast is dismissed as soon as that tab disconnects
  or starts reconnecting, and a reconnect replaces it instead of adding a second
  one. Local shells no longer show a "Connected" toast (#5618).
- Toasts stay clear of editor and dialog footers (Save, Cancel) and of the
  Transfers panel, and an error or unlock dialog clears stale success toasts
  (#5618).
