### Security

- Dependencies: updated the Tauri 2 stack to 2.12 (crates and `@tauri-apps/*`
  packages). This removes the five unmaintained `unic-*` crates and their
  RUSTSEC ignores (#3054).
- Supply chain: the remaining Rust advisory exceptions (`rsa`, GTK3 `glib` and
  `proc-macro-error`) and the pre-release RustCrypto/Dalek crates under russh
  are now documented accepted risks in `docs/supply-chain.md`, each with the
  reason it is not exploitable (#3734).
