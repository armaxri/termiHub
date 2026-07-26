### Added

- Plugin code signing: `.termihub-plugin` packages can now be signed with an
  Ed25519 keypair and verified at install. A signed package embeds a
  `signature.json` (a per-entry SHA-256 digest map plus one signature over a
  canonical form of it), so the host can confirm offline that the package was
  built by a specific key and has not been altered — covering the whole payload,
  not just the manifest. Two first-party tools land behind the `plugin` feature:
  `termihub-plugin-keygen` (mint a publisher keypair + fingerprint) and
  `termihub-plugin-sign` (write `signature.json` into a built package);
  `scripts/package-plugin.{sh,cmd}` gain a `--sign <key>` step.
- Install-time trust gate: the install dialog now shows a four-state provenance
  banner — **Verified** (trusted key, no warning), **Signed** (valid but unknown
  key, with a "Trust this publisher" trust-on-first-use option), **Untrusted**
  (unsigned, the existing acknowledgement), and **Tampered** (invalid signature,
  hard-blocked with no override). A new **Settings → Plugins → Trusted
  Publishers** group lists bundled and user-pinned publisher keys and revokes
  pinned ones. Trust is stored in `<app-data>/plugins/trust-store.json`
  (portable-mode aware). Unsigned plugins keep working exactly as before.
