### Security

- Hardened the plugin FFI and native-library-loading trust boundary
  (CORE-033/034/035/036):
  - Plugin package signatures are now verified with Ed25519 `verify_strict`
    instead of plain `verify`, rejecting small-order (weak) keys, non-canonical
    encodings, and the malleability those allow — so a valid signature means
    "signed exactly once by this publisher" (CORE-033).
  - Backend-library selection is deterministic: a plugin directory with more than
    one library matching the platform's extension is refused as ambiguous rather
    than loading a nondeterministically-chosen file, and the exact bytes about to
    be loaded are re-checked against their signed digest immediately before
    `dlopen`, catching a file swapped in after verification (CORE-034).
  - The host capability bridge's `list_dir` now frames directory entries with an
    unambiguous length-prefixed encoding, so a filename that legally contains a
    newline is returned as a single entry instead of splitting into or injecting
    spurious entries (CORE-035).
  - The FFI bridge context reference handed to plugin callbacks is now
    lifetime-bounded to the call and null/type-sanity-checked before use, closing
    a potential use-after-free if a plugin retained or corrupted the pointer
    (CORE-036).
