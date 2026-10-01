### Fixed

- Cancelling agent setup, deploy or update now stops an in-progress agent binary upload right
  away instead of waiting for the upload to finish, and still removes the partial file from the
  remote host (#4060).
