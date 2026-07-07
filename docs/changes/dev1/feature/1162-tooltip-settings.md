## Changed

- The remaining interactive icon-only controls in Settings — the file-type mapping
  Remove and copy-into-add-form buttons, the SSH key-path Browse button, the settings
  search Clear button, the per-shortcut Reset button, the external-file Remove button,
  the language-package Install / Uninstall buttons, the custom-grammar Remove button,
  and the serial-port custom-prefix Remove button — now use the shared accessible
  Tooltip for hover help: consistent, themed, and reachable on keyboard focus instead
  of mouse-only. Each converted control exposes its label as a proper accessible name
  (`aria-label`) rather than only through the browser `title`. Non-interactive
  full-text/truncation hovers (git commit hash, file paths) are unchanged.
