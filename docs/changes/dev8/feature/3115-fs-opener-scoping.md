### Security

- The app window can no longer read or write files on its own beyond what you
  pick in a native open/save dialog: the blanket file-system read access to
  termiHub's own config and data folders, and the "open any path" permission,
  were removed. External links open only `http`, `https` and `mailto` URLs
  (#3115).

### Fixed

- File browser: "Open in Finder / Explorer / File Manager" works again; it now
  opens only real local folders, and an app bundle such as `Foo.app` is shown in
  its parent folder instead of being launched (#3115).
- File browser: copying, uploading or downloading files between the local disk
  and a session on a remote agent no longer fails with a permission error
  (#3115).
