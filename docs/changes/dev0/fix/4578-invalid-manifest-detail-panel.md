### Fixed

- Plugins: the detail panel for an installed plugin whose manifest no longer
  validates no longer offers a Retry that could only fail again, and no longer
  renders an empty meta line (`v · by  · plugin`) or an empty Extension Points
  block. It now shows the rejection reason, a hint to uninstall or install a
  fixed version, and Uninstall. Load failures keep Retry (#4578).
