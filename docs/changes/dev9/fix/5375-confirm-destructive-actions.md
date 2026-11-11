### Changed

- Stopping a persistent (background) session now asks first: "Stop 'X'? It is
  running in the background and will end." This applies to the Stop button and
  menu item in the connection tree and the agent tree, and to the single Stop
  in Open Connections. Stopping a session that is not persistent is unchanged
  (#5375).
- Keyboard "Reset to Safer Defaults" and "Import Shortcuts" now ask first when
  you have custom bindings, and say how many will be replaced. Afterwards a
  10-second Undo toast restores your previous bindings (#5375).
- File types "Reset All" now asks first and says how many custom mappings will
  be removed (#5375).
