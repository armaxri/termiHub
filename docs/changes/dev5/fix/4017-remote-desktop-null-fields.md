### Fixed

- VNC and RDP connections created in the connection editor open again. Fields
  left empty (for example the VNC username or the unused SSH-tunnel fields) were
  sent as empty values the backend rejected, so the tab showed "Invalid VNC
  settings: invalid type: null, expected a string" (#4017).
