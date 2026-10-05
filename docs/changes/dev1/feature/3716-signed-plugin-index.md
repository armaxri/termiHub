### Security

- The curated plugin index is now signed: termiHub checks the index's Ed25519 signature
  (`index.json.sig`, separate termiHub plugin-index key) before reading it, and release builds
  only accept the default index when the signature verifies. Browse Plugins shows whether the
  loaded index is verified, unsigned (custom indexes), or not checked (builds made before the
  signing key was set up) (#3716)
