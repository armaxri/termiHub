### Fixed

- The Docker container file browser now lists directories correctly on BusyBox
  images (Alpine and most minimal containers). Listing previously used the
  GNU-only `find -printf`, which BusyBox `find` does not implement, so browsing
  failed on exactly the most common base images (Alpine is the connection
  schema's own example image). It now uses a portable command that derives every
  field with tools BusyBox and GNU coreutils both provide, so it works on both
  (CORE-012).

### Changed

- The Docker file browser now uses the `base64` crate to move file content
  across the `docker exec` boundary instead of a hand-rolled encoder/decoder.
  The strict decoder surfaces an error on corrupted (non-base64) exec output
  rather than silently dropping the offending bytes, so a read can no longer
  return quietly corrupted file content (LIBBE-001).
