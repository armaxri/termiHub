### Changed

- Several search boxes now share the same look and behavior as the connection
  and manager sidebars, migrated to the shared `SearchInput` primitive: the
  Settings search, Keyboard Shortcuts settings search, Language Packages search,
  the Keyboard Shortcuts overlay, the icon picker, the Plugins sidebar search,
  and the Workspace editor connection picker. Each now shows a leading search
  icon and a clear (✕) button while a query is present — the clear button is new
  on the fields that previously lacked one (part of #2928, UISF-004 follow-up).
