### Fixed

- Terminal tab ids are now globally unique by construction, so tabs opened in
  different desktop windows can no longer share an id. Previously each window
  minted tab ids from its own `tab-0`, `tab-1`, … counter, so two windows
  produced colliding ids. Because tab ids double as cross-window / shared-region
  keys (persistent-session attach, session hand-off, layout projection keys), a
  collision could let a cross-window operation target the wrong window's tab.
  Existing saved/restored tabs keep working — ids remain opaque strings, so old
  `tab-N` and new `tab-<uuid>` ids coexist with no migration (FES-004).
