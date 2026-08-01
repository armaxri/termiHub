### Fixed

- Fixed a sidebar bug where hiding the sidebar (or otherwise rebuilding its
  section list) while dragging a section-resize handle left the mouse listeners
  attached and the whole window stuck with a resize cursor and text selection
  disabled until the next interaction. ([#2361](https://github.com/armaxri/termiHub/issues/2361))
