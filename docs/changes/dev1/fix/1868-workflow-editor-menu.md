### Fixed

- Workflow editor: the **"+ Add step…"** menu and the **Run macro** picker now
  open and are clickable inside the editor dialog. As a modal Radix `Dialog`,
  the editor disables pointer events on `document.body`, so menus that portalled
  to the body (the Radix default) rendered outside the dialog and were dead in
  the running app — you could not add any steps to a workflow. The shared `Modal`
  primitive now exposes its content node as a portal container, and menus/selects
  inside a modal portal into the dialog subtree where pointer events are enabled,
  so this cannot silently recur for other dialogs (#1868).
