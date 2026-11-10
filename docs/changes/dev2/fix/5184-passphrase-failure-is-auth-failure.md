### Fixed

- SSH: a wrong or missing key passphrase is now treated as a rejected
  credential instead of "Failed to spawn terminal". The connect re-prompts for
  the passphrase ("The saved passphrase was rejected"), keeps the saved one
  until a replacement connects, and an open tab offers its "Update Credentials"
  form. A missing or unsupported key file still fails with a clear message
  naming the file (#5184).
