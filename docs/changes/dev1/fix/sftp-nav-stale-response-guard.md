### Fixed

- Fixed the file browser landing on the wrong folder during fast navigation: when
  you opened folder B while folder A's listing was still loading and A's response
  arrived last, the browser would snap back to folder A. Directory listings are now
  applied in navigation order, so the view always reflects the folder you last
  opened and stale responses are discarded (SM-007).
