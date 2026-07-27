### Security

- Plugin install now binds signature verification to the bytes it actually
  extracts and loads. Previously the package signature was checked on one open of
  the file and the archive was then re-opened for extraction, so a package swapped
  between those two steps could land unverified bytes on disk (a verify-then-use
  TOCTOU). Extraction now re-verifies against the freshly-opened archive and
  refuses to write any entry that does not match the signed digest map from the
  approved signer — a tampered, re-signed, or dropped signature after the trust
  gate is rejected as `SignatureTampered` (#2045).
