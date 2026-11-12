//! Regression matrix for passphrase-protected legacy-PEM EC keys (#845, #5500).
//!
//! The fixtures in `core/tests/fixtures/legacy-pem/` are the repo's
//! `tests/fixtures/ssh-keys/ecdsa_{256,384,521}` test keys re-encoded as
//! traditional OpenSSL SEC1 PEM, so every load is checked against the known
//! public key in the matching `.pub` file, not just "some key came out".
//!
//! The canary [`russh_still_cannot_load_encrypted_legacy_pem_ec_keys`] pins the
//! upstream limitation that `legacy_pem.rs` works around. When a russh upgrade
//! makes it fail, russh loads these keys itself: delete `legacy_pem.rs` and its
//! direct dependencies, and keep the rest of this matrix as the regression test
//! for the library path.

use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;

use super::*;
use crate::errors::ConnectFailureKind;

/// The passphrase of every encrypted fixture.
const PASSPHRASE: &str = "testpass123";

/// The AES-encrypted fixtures: (file, matching public key in `ssh-keys/`).
const ENCRYPTED: &[(&str, &str)] = &[
    ("ecdsa_256_aes128.pem", "ecdsa_256.pub"),
    ("ecdsa_256_aes192.pem", "ecdsa_256.pub"),
    ("ecdsa_256_aes256.pem", "ecdsa_256.pub"),
    ("ecdsa_384_aes128.pem", "ecdsa_384.pub"),
    ("ecdsa_384_aes192.pem", "ecdsa_384.pub"),
    ("ecdsa_384_aes256.pem", "ecdsa_384.pub"),
    ("ecdsa_521_aes128.pem", "ecdsa_521.pub"),
    ("ecdsa_521_aes192.pem", "ecdsa_521.pub"),
    ("ecdsa_521_aes256.pem", "ecdsa_521.pub"),
    // Explicit curve parameters instead of a named-curve OID.
    ("ecdsa_256_explicit_aes128.pem", "ecdsa_256.pub"),
];

/// The unencrypted SEC1 fixtures, which russh loads natively.
const UNENCRYPTED: &[(&str, &str)] = &[
    ("ecdsa_256.pem", "ecdsa_256.pub"),
    ("ecdsa_384.pem", "ecdsa_384.pub"),
    ("ecdsa_521.pem", "ecdsa_521.pub"),
];

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/legacy-pem")
        .join(name)
}

fn read_fixture(name: &str) -> String {
    std::fs::read_to_string(fixture(name)).expect("read fixture")
}

/// The public key a fixture must load to.
fn expected_public(pub_name: &str) -> PublicKey {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/ssh-keys")
        .join(pub_name);
    let text = std::fs::read_to_string(path).expect("read public key");
    PublicKey::from_openssh(text.trim()).expect("parse public key")
}

fn load(name: &str, passphrase: Option<&str>) -> Result<PrivateKey, SessionError> {
    load_private_key(&fixture(name), "~/.ssh/id_test", passphrase, false)
}

#[test]
fn russh_still_cannot_load_encrypted_legacy_pem_ec_keys() {
    for (name, _) in ENCRYPTED {
        let pem = read_fixture(name);
        assert!(
            russh::keys::decode_secret_key(&pem, Some(PASSPHRASE)).is_err(),
            "russh now loads {name} itself: remove legacy_pem.rs and its \
             dependencies, and keep this matrix as a regression test (#5500)"
        );
    }
}

#[test]
fn russh_loads_unencrypted_legacy_pem_ec_keys() {
    for (name, pub_name) in UNENCRYPTED {
        let key = russh::keys::decode_secret_key(&read_fixture(name), None)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            key.public_key().key_data(),
            expected_public(pub_name).key_data(),
            "{name}"
        );
        let key = load(name, None).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(
            key.public_key().key_data(),
            expected_public(pub_name).key_data(),
            "{name}"
        );
    }
}

#[test]
fn encrypted_legacy_pem_ec_keys_load_to_the_expected_public_key() {
    for (name, pub_name) in ENCRYPTED {
        let key = load(name, Some(PASSPHRASE)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(
            key.public_key().key_data(),
            expected_public(pub_name).key_data(),
            "{name}"
        );
    }
}

#[test]
fn encrypted_legacy_pem_ec_keys_with_a_wrong_passphrase_are_auth_failed() {
    for (name, _) in ENCRYPTED {
        for wrong in ["wrong-passphrase", ""] {
            let err = load(name, Some(wrong)).expect_err(name);
            assert!(matches!(err, SessionError::AuthFailed), "{name}: {err:?}");
        }
    }
}

#[test]
fn encrypted_legacy_pem_ec_keys_without_a_passphrase_need_one() {
    for (name, _) in ENCRYPTED {
        let err = load(name, None).expect_err(name);
        assert!(matches!(err, SessionError::AuthFailed), "{name}: {err:?}");

        let err = load_private_key(&fixture(name), "~/.ssh/id_test", None, true).expect_err(name);
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::InteractionRequired),
            "{name}: {err:?}"
        );
    }
}

#[test]
fn legacy_pem_ec_key_with_an_unsupported_cipher_names_the_cipher() {
    // DES-EDE3-CBC: no passphrase can make it load, so it must not read as a
    // wrong passphrase, and the message must say what to do.
    for passphrase in [PASSPHRASE, "wrong-passphrase"] {
        let err = load("ecdsa_256_des3.pem", Some(passphrase)).expect_err("des3");
        match err {
            SessionError::SpawnFailed(msg) => {
                assert!(msg.contains("DES-EDE3-CBC"), "{msg}");
                assert!(msg.contains("ssh-keygen -p"), "{msg}");
                assert!(msg.contains("~/.ssh/id_test"), "{msg}");
            }
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }
}
