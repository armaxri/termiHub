### Security

- Plugin packages are now protected against decompression (zip-bomb) denial of
  service. Reading a `.termihub-plugin` archive is bounded by a per-entry
  decompressed cap (128 MB) and a whole-package decompressed budget (256 MB) on
  the trust-assessment, manifest, and extraction paths, so a small malicious
  archive can no longer inflate to exhaust host memory. The compressed-size
  check now also runs _before_ trust assessment rather than only inside package
  validation.
