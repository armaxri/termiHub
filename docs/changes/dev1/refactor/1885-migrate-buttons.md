### Changed

- Design-system consolidation: the residual bespoke panel, banner, overlay and
  toolbar buttons now compose the shared `Button` primitive, so they pick up the
  system's tokenized skin, focus ring, hover and disabled states. Affected
  surfaces include the terminal disconnect/reconnect overlays, the view-mode
  banner, the agent-error and file-browser tabs, the terminal and log-viewer
  toolbars, and the sidebar connection/tunnel/network actions. Behaviour,
  labels, icons and keyboard focus are unchanged; some of these controls shift
  slightly in size to the standard control heights.
