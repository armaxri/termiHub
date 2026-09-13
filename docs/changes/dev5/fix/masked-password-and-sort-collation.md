### Changed

- The "Save as Connection" dialog's credential-store password field now uses the
  shared password input, gaining a show/hide reveal toggle and the Caps Lock
  warning that other password fields already have (UISF-015).
- Filename, hostname, and connection-name lists now sort with locale-aware,
  natural-number collation: `file2` sorts before `file10`, and differences in
  letter case or accents no longer scatter otherwise-adjacent entries. This
  applies to the file browser, SSH key pickers, SSH-config/fleet import lists,
  the icon picker, language selectors, and file-type mappings (I18N-014).
