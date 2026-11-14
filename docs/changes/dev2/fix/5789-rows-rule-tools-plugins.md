### Changed

- Network Tools monitor rows and plugin rows now follow the "names, not
  settings" rule:
  - An HTTP monitor can have an optional name and one-line description (at
    most 80 characters), set in the HTTP Monitor panel. The sidebar row shows
    the name (the URL when there is none) and the description, plus a marker
    only when the monitor is stopped, paused, overdue or down. The URL, method,
    interval and latest reading are in a tooltip on the name.
  - Plugins sidebar rows show the plugin's description under its name and a
    marker when a plugin is disabled or has an error. The version, author and
    ID are in the tooltip, and search also matches the description.
  - Settings ▸ Plugins ▸ Native plugins rows no longer show the version or
    "trusted". "Not trusted" and "Needs re-approval" stay on the row; the
    version, author and ID are in a tooltip on the name.
