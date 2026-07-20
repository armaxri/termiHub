### Changed

- RDP clipboard file transfer now preserves **directory structure** and streams
  **large files** in both directions (#1780). Receiving: a copied folder tree is
  recreated under the shared folder (each descriptor's relative path is honoured
  and its subdirectories are created, validated through the sandbox per entry)
  instead of being flattened, and files larger than 32 MiB are fetched over
  successive bounded `RANGE` chunks and written incrementally rather than being
  skipped. Serving: the shared folder and copied host-clipboard folders are
  advertised **recursively** (directory + file descriptors carrying their
  relative paths, symlinks skipped) and large local files are offered and served
  a chunk at a time. In both directions the sidecar never buffers a whole file,
  so memory stays bounded regardless of file size.
