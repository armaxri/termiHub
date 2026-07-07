## Added

- The Open Connections panel's "X Servers" row now shows how many live SSH X11-forwarding
  sessions depend on the shared X server (e.g. `display :0 · 2 sessions`). The count is tracked
  as sessions connect and disconnect, and returns to zero (with the row's detail dropping the
  "sessions" suffix) once nothing is using the server.
