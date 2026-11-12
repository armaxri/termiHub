//! Passphrase handling across every private-key format (#5503).
//!
//! Each key format is loaded with no passphrase, the correct one, a wrong
//! one, and an empty one. An unencrypted key ignores any passphrase, as
//! OpenSSH does; an encrypted key needs the right one. Every successful load
//! is checked against the known public key in `tests/fixtures/ssh-keys/`.
//!
//! The PEM fixtures in `core/tests/fixtures/legacy-pem/` are the repo's
//! `tests/fixtures/ssh-keys/` test keys re-encoded (see that dir's README).

use std::path::PathBuf;

use russh::keys::ssh_key::PublicKey;

use super::*;
use crate::errors::ConnectFailureKind;

/// The passphrase of every encrypted fixture.
const PASSPHRASE: &str = "testpass123";

/// Passphrases that do not decrypt any fixture.
const WRONG: &[&str] = &["wrong-passphrase", ""];

/// Where a fixture lives.
#[derive(Clone, Copy)]
enum Dir {
    /// `tests/fixtures/ssh-keys/` (OpenSSH format).
    SshKeys,
    /// `core/tests/fixtures/legacy-pem/` (PEM re-encodings).
    Pem,
}

/// One key: (fixture, its dir, matching `.pub` in `ssh-keys/`, encrypted).
struct Case {
    file: &'static str,
    dir: Dir,
    public: &'static str,
    encrypted: bool,
}

const fn case(file: &'static str, dir: Dir, public: &'static str, encrypted: bool) -> Case {
    Case {
        file,
        dir,
        public,
        encrypted,
    }
}

const CASES: &[Case] = &[
    // OpenSSH format.
    case("ed25519", Dir::SshKeys, "ed25519.pub", false),
    case(
        "ed25519_passphrase",
        Dir::SshKeys,
        "ed25519_passphrase.pub",
        true,
    ),
    case("rsa_2048", Dir::SshKeys, "rsa_2048.pub", false),
    case(
        "rsa_2048_passphrase",
        Dir::SshKeys,
        "rsa_2048_passphrase.pub",
        true,
    ),
    case("ecdsa_256", Dir::SshKeys, "ecdsa_256.pub", false),
    case(
        "ecdsa_256_passphrase",
        Dir::SshKeys,
        "ecdsa_256_passphrase.pub",
        true,
    ),
    // PKCS#1 RSA (`BEGIN RSA PRIVATE KEY`).
    case("rsa_2048_pkcs1.pem", Dir::Pem, "rsa_2048.pub", false),
    case("rsa_2048_pkcs1_aes128.pem", Dir::Pem, "rsa_2048.pub", true),
    // PKCS#8 (`BEGIN PRIVATE KEY` / `BEGIN ENCRYPTED PRIVATE KEY`).
    case("rsa_2048_pkcs8.pem", Dir::Pem, "rsa_2048.pub", false),
    case("rsa_2048_pkcs8_aes256.pem", Dir::Pem, "rsa_2048.pub", true),
    case("ecdsa_256_pkcs8.pem", Dir::Pem, "ecdsa_256.pub", false),
    case(
        "ecdsa_256_pkcs8_aes256.pem",
        Dir::Pem,
        "ecdsa_256.pub",
        true,
    ),
    case("ed25519_pkcs8.pem", Dir::Pem, "ed25519.pub", false),
    case("ed25519_pkcs8_aes256.pem", Dir::Pem, "ed25519.pub", true),
    // SEC1 EC (`BEGIN EC PRIVATE KEY`), named and explicit curve parameters.
    case("ecdsa_256_named.pem", Dir::Pem, "ecdsa_256.pub", false),
    case("ecdsa_256.pem", Dir::Pem, "ecdsa_256.pub", false),
    case("ecdsa_384.pem", Dir::Pem, "ecdsa_384.pub", false),
    case("ecdsa_521.pem", Dir::Pem, "ecdsa_521.pub", false),
    case("ecdsa_256_aes128.pem", Dir::Pem, "ecdsa_256.pub", true),
    case(
        "ecdsa_256_explicit_aes128.pem",
        Dir::Pem,
        "ecdsa_256.pub",
        true,
    ),
];

fn path(case: &Case) -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    match case.dir {
        Dir::SshKeys => root.join("../tests/fixtures/ssh-keys"),
        Dir::Pem => root.join("tests/fixtures/legacy-pem"),
    }
    .join(case.file)
}

fn expected_public(case: &Case) -> PublicKey {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/ssh-keys")
        .join(case.public);
    let text = std::fs::read_to_string(path).expect("read public key");
    PublicKey::from_openssh(text.trim()).expect("parse public key")
}

fn load(case: &Case, passphrase: Option<&str>) -> Result<PrivateKey, SessionError> {
    load_private_key(&path(case), "~/.ssh/id_test", passphrase, false)
}

/// Assert `result` is a key with the case's known public key.
fn assert_loads(case: &Case, label: &str, result: Result<PrivateKey, SessionError>) {
    let key = result.unwrap_or_else(|e| panic!("{} ({label}): {e:?}", case.file));
    assert_eq!(
        key.public_key().key_data(),
        expected_public(case).key_data(),
        "{} ({label})",
        case.file
    );
}

#[test]
fn every_fixture_is_classified_by_its_structure() {
    for case in CASES {
        let text = std::fs::read_to_string(path(case)).expect("read fixture");
        assert_eq!(is_encrypted_key(&text), case.encrypted, "{}", case.file);
    }
}

#[test]
fn every_key_loads_with_the_correct_passphrase() {
    for case in CASES {
        assert_loads(case, "correct", load(case, Some(PASSPHRASE)));
    }
}

#[test]
fn unencrypted_keys_load_without_a_passphrase() {
    for case in CASES.iter().filter(|c| !c.encrypted) {
        assert_loads(case, "none", load(case, None));
    }
}

#[test]
fn unencrypted_keys_ignore_a_superfluous_passphrase() {
    for case in CASES.iter().filter(|c| !c.encrypted) {
        for wrong in WRONG {
            assert_loads(
                case,
                &format!("superfluous {wrong:?}"),
                load(case, Some(wrong)),
            );
        }
    }
}

#[test]
fn encrypted_keys_with_a_wrong_passphrase_are_auth_failed() {
    for case in CASES.iter().filter(|c| c.encrypted) {
        for wrong in WRONG {
            let err = load(case, Some(wrong)).expect_err(case.file);
            assert!(
                matches!(err, SessionError::AuthFailed),
                "{} ({wrong:?}): {err:?}",
                case.file
            );
        }
    }
}

#[test]
fn encrypted_keys_without_a_passphrase_need_one() {
    for case in CASES.iter().filter(|c| c.encrypted) {
        let err = load(case, None).expect_err(case.file);
        assert!(
            matches!(err, SessionError::AuthFailed),
            "{}: {err:?}",
            case.file
        );

        let err = load_private_key(&path(case), "~/.ssh/id_test", None, true).expect_err(case.file);
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::InteractionRequired),
            "{}: {err:?}",
            case.file
        );
    }
}
