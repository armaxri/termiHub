### Changed

- Split drag-to-drop preview and Network Tools row highlights now follow the
  active theme's accent/status colors instead of a fixed VS-Code blue, so they
  no longer clash under Solarized or custom themes (UI-003).
- Terminal- and remote-desktop-covering overlays (connecting, reconnecting,
  disconnected, and error states) now share one backdrop treatment — a subtle
  translucent blur — instead of four different opaque/translucent/scrim
  looks, so connection-state transitions read as intentional (UI-008).
- Extended the typography token scale with caption (10px) and display
  (16/20/22px) tiers and migrated component font sizes onto the tokens, giving
  small labels and headings a consistent rhythm across the app (UI-005).
  </content>
