### Security

- Hardened `.termihub-plugin` package extraction against two additional attacks: a
  package is now rejected if it declares more than 8192 entries, and any symbolic-link
  entry is refused rather than written to disk (so an extracted symlink cannot later
  escape the plugin directory). The per-entry and total decompressed-size caps and the
  path-traversal guard were already enforced.
