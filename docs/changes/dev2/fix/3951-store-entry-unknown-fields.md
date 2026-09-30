### Fixed

- Settings a newer termiHub adds to a single embedded server, Wake-on-LAN device or
  HTTP monitor now survive when an older version saves the file (#3951). Previously
  only unknown top-level settings were kept; per-entry ones were dropped on the next
  save, including when the entry was edited.
