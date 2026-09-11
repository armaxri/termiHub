### Fixed

- A failed Docker connection no longer leaks a running container. When the
  container was created and started but a later connect step (setting up the
  interactive exec) failed, the started container was never stopped or removed —
  so repeated failed connects piled up orphaned containers on the host. The
  connect error path now tears the started container down before surfacing the
  error (CORE-009).
- Docker container file operations (read / list / delete / rename / write) no
  longer report a failed command as success. A `docker exec` whose exit status
  could not be determined was previously treated as exit `0`, so a failed read
  looked like an empty file and a failed delete looked done. An unknown or
  non-zero exit code is now surfaced as an error (CORE-010).
