## Changed

- Three interactive text-buttons in the status bar that open a dropdown menu — the
  indentation selector ("Select indentation"), the monitoring connect button
  ("Connect monitoring"), and the language-mode selector ("Select language mode") —
  now use the shared accessible Tooltip for hover help instead of a bare browser
  `title`. Each tooltip names the action, which is distinct from the value shown in
  the button's visible label (e.g. "Spaces: 2", "TypeScript"), mirroring VS Code's
  status-bar behavior. The hints are consistent, themed, and reachable on keyboard
  focus, and each control exposes its action as a proper accessible name
  (`aria-label`).
- The monitoring host button no longer shows a redundant hover title in its normal
  state (it duplicated the hostname already visible in the label); a title is kept
  only while the host is reconnecting, where it conveys transient state.
