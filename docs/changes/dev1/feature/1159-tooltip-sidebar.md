## Changed

- Interactive icon-only row action controls in the Sidebar connection tree — the
  Connections / Remote Agents group actions (New Folder, New Connection, New Remote
  Agent), the persistent-session Start / Attach / Stop controls, the inline folder
  Confirm / Cancel buttons, and the file browser toolbar and row-menu actions — now
  use the shared accessible Tooltip for hover help: consistent, themed, and reachable
  on keyboard focus instead of mouse-only. Each converted control exposes its label as
  a proper accessible name (`aria-label`) rather than only through the browser `title`.
  Full-text/truncation hovers on connection, host, and session names (and connection
  status text) are unchanged.
