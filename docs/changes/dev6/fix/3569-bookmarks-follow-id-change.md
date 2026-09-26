### Fixed

- File browser bookmarks of a saved connection are kept when the connection is renamed or moved to
  another folder, and when a folder above it is renamed or deleted. They used to stay behind under
  the connection's old id and disappear from the Bookmarks menu. If the new location already had
  bookmarks, both lists are merged without duplicates. (#3569)
