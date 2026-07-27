### Fixed

- Credential unlock no longer crashes the app when the stored credentials file
  has a truncated or corrupted nonce or salt. The unlock path now validates the
  nonce and salt lengths before use and reports the file as corrupted (a
  recoverable error offering the reset-store recovery), instead of panicking
  inside `Nonce::from_slice` (#2049).
