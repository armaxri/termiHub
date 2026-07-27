### Security

- The `read_plugin_file` IPC command now validates the plugin `id` with the same
  filesystem-safe slug rule enforced at manifest install time before joining it
  into a path. Previously a traversing `id` (one containing `..` or path
  separators) supplied by the renderer could escape the plugin root and read
  arbitrary files off disk; such ids are now refused.
