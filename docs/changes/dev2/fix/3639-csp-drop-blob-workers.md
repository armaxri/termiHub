### Security

- The content security policy no longer allows `blob:` workers (`worker-src` and
  `child-src` are now `'self'` only) (#3639). Every worker the app starts, from the
  editor's language workers to the plugin sandbox, loads from a bundled file.
