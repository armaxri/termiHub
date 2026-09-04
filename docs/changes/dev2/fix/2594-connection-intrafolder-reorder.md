### Fixed

- Connections sidebar: dragging a connection to a new position **within its
  folder** now reorders it, and the new order persists across reloads. Previously
  a connection could be dragged into a different folder, but dropping it onto a
  sibling inside the same folder did nothing (or moved it to the root). Dropping a
  connection onto another connection in the same folder now reorders the two;
  dropping onto a connection in a different folder still moves it into that folder
  (#2594).
