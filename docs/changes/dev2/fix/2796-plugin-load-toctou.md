### Security

- Native plugin loading is now anchored to the publisher trust store and to the
  install record (#2796). A signed plugin loads only while its signing key is
  still trusted (a key revoked since install is refused), and the backend library
  must match the digest verified at install, which is kept in `plugin-state.json`
  outside the plugin folder. A plugin whose library was swapped and re-signed
  after install is therefore refused. Reinstall the plugin to load new bytes. A
  signed plugin installed with "Install once" (key not trusted) still loads, but
  only while it carries the same key and bytes it was installed with.
- The backend library is hashed through a file handle that stays open across the
  load. On Linux the library is loaded from that exact file, on Windows it cannot
  be changed while the load runs, and on macOS a replacement is detected and the
  plugin is unloaded.
- `plugin-state.json` now has a version (schema v2). A file written by a newer
  termiHub is never overwritten, and fields this version does not know are kept.
