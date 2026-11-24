### Fixed

- A new connection no longer opens with "Name is required." in red. The
  connection editor and the tunnel editor now show a field's error only after
  you have changed the field and moved on, or when you try to save. Trying to
  save shows every problem at once, including the connection's own fields, and
  moves the cursor to the first one. Save still refuses while something is
  missing (#5909).
