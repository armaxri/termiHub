### Fixed

- Connection type icons are easier to tell apart (#5850). SSH connections now show a framed
  terminal instead of a key, so the key only means saved credentials (the Keychain indicator).
  Telnet shows a network glyph instead of the web globe. RDP shows a monitor with a cog,
  so it no longer looks like a plain variant of the VNC screen-share glyph. The sidebar,
  tabs, the connection editor's type picker and the command palette all use the same icons.
- The jump-host marker on a connection row is now a route glyph with a tooltip and accessible
  name, "Connects via <bastion>", instead of an unexplained '⇆'.
