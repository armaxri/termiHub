### Fixed

- Embedded servers: deleting a service that fails on the backend now surfaces a
  visible error toast instead of failing silently. The store's
  `deleteEmbeddedServer` previously swallowed backend errors to `console.error`
  and resolved as if the delete had succeeded, so the sidebar's error toast never
  fired. The failure now propagates to the caller and the server remains listed.
