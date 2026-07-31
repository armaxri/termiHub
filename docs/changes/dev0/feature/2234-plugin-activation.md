### Fixed

- Plugins now actually **activate**. An enabled, compatible plugin whose host
  load succeeds is reported with `state: "active"` — both at startup and on a
  live enable — instead of resting at `installed` forever. Previously no plugin
  ever reached `active`, so the three activation-gated extension points were
  silently inert in real builds: frontend JS plugins (protocol parsers /
  status-bar widgets), plugin color themes, and plugin backend connection types.
  Frontend-only plugins (theme / JS, no native backend library) activate too.
  Frontend-plugin JS execution remains behind its existing default-off
  experimental opt-in (#2234).
