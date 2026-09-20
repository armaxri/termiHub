### Changed

- The in-browser file-transfer list (shown in the file browser footer) is now
  fully consolidated with the docked Transfer Queue panel (UX-020 follow-up,
  #2905). Both surfaces render from the one authoritative transfers projection
  region and share a single row/control component (a compact variant of the
  Transfer Queue row), so there is no longer a divergent second data model or row
  layout. As a result the footer now retains finished transfers as terminal rows
  with a Remove control (and Retry/Pause/Resume where the backend supports them),
  matching the panel, instead of clearing a transfer the moment it completes.
