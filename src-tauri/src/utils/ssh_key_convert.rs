//! SSH key utilities — retained for API compatibility.
//!
//! Key format detection and conversion previously required `openssl` and
//! `ssh-key`. Since the migration to `russh`, [`russh_keys::load_secret_key`]
//! natively handles all OpenSSH, PEM, and PKCS#8 key formats, so this module
//! has no remaining responsibilities.
//!
//! Callers that previously used `prepare_key` / `PreparedKey` should call
//! [`termihub_core::backends::ssh::auth::connect_and_authenticate`] directly;
//! it handles key loading internally.
