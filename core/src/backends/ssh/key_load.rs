//! Loading the private key for SSH key auth, with a typed failure (#5184).
//!
//! A key that cannot be **decrypted** is a credential problem, not a broken
//! connection: the passphrase is wrong, or there is none. Such a failure is
//! the typed [`SessionError::AuthFailed`], the same signal as a server that
//! rejects a password. The frontend then offers to re-enter the passphrase
//! (for a key connection the secret to re-enter is the key passphrase), and a
//! saved passphrase is kept rather than discarded (#5156).
//!
//! Every other load failure keeps the untyped [`SessionError::SpawnFailed`]
//! with a clear message, because no passphrase can fix it: the file is
//! missing or unreadable, it is not a private key, or its format or cipher is
//! not supported.
//!
//! Unattended (#3877), an encrypted key with no passphrase is still the typed
//! `InteractionRequired` refusal, since nobody is there to type one.

use std::path::Path;

use russh::keys::PrivateKey;

use crate::errors::SessionError;

use super::legacy_pem::{self, LegacyPemError};

/// Load the private key at `key_path` for key auth.
///
/// `display` names the key in messages (the configured, unexpanded path).
/// `passphrase` is the secret to decrypt it with, if any. `unattended` turns a
/// missing passphrase into the typed unattended refusal instead of an
/// [`SessionError::AuthFailed`].
pub(super) fn load_private_key(
    key_path: &Path,
    display: &str,
    passphrase: Option<&str>,
    unattended: bool,
) -> Result<PrivateKey, SessionError> {
    let contents = std::fs::read_to_string(key_path).map_err(|e| {
        SessionError::SpawnFailed(format!("Failed to load key: cannot read {display}: {e}"))
    })?;

    let original = match russh::keys::decode_secret_key(&contents, passphrase) {
        Ok(key) => return Ok(key),
        Err(e) => e,
    };

    // russh 0.61 can't load passphrase-protected legacy-PEM EC keys (its
    // PKCS#5 path assumes RSA), so those go through our own loader.
    if legacy_pem::is_encrypted_ec_pem(&contents) {
        let Some(passphrase) = passphrase else {
            return Err(missing_passphrase(display, unattended));
        };
        return legacy_pem::load(&contents, passphrase).map_err(|e| match e {
            // A wrong passphrase decrypts to garbage: the padding or the SEC1
            // parse of the plaintext fails.
            LegacyPemError::Decrypt | LegacyPemError::UnsupportedCurve => SessionError::AuthFailed,
            other => SessionError::SpawnFailed(format!("Failed to load key {display}: {other}")),
        });
    }

    if !is_encrypted_key(&contents) {
        return Err(SessionError::SpawnFailed(format!(
            "Failed to load key {display}: {original}"
        )));
    }
    if passphrase.is_none() {
        return Err(missing_passphrase(display, unattended));
    }
    // russh decrypts traditional PEM only with AES-128-CBC. Another cipher
    // would fail as if the passphrase were wrong, and re-entering it would
    // never help, so name the cause instead.
    if let Some(cipher) = unsupported_pem_cipher(&contents) {
        return Err(SessionError::SpawnFailed(format!(
            "Failed to load key {display}: the key is encrypted with {cipher}, which is not \
             supported. Re-encrypt it with `ssh-keygen -p -f <key file>`."
        )));
    }
    if is_structural_error(&original) {
        return Err(SessionError::SpawnFailed(format!(
            "Failed to load key {display}: {original}"
        )));
    }
    // An encrypted key, a passphrase, and a failed decrypt: the passphrase
    // was rejected.
    Err(SessionError::AuthFailed)
}

/// The failure for an encrypted key that has no passphrase.
fn missing_passphrase(display: &str, unattended: bool) -> SessionError {
    if unattended {
        super::unattended::passphrase_required(display)
    } else {
        SessionError::AuthFailed
    }
}

/// Whether the key text is passphrase-encrypted, read from its structure.
///
/// Mirrors the desktop's connect-time check that decides whether to ask for a
/// passphrase (`is_ssh_key_encrypted`, #885), and also covers PuTTY keys.
fn is_encrypted_key(contents: &str) -> bool {
    // Traditional OpenSSL PEM encryption (RSA/EC/DSA): Proc-Type + DEK-Info.
    if contents.contains("Proc-Type:") && contents.contains("ENCRYPTED") {
        return true;
    }
    // Explicitly-labelled encrypted PKCS#8.
    if contents.contains("BEGIN ENCRYPTED PRIVATE KEY") {
        return true;
    }
    let trimmed = contents.trim();
    // PuTTY: an `Encryption:` header other than `none`.
    if trimmed.starts_with("PuTTY-User-Key-File-") {
        return trimmed
            .lines()
            .filter_map(|l| l.strip_prefix("Encryption:"))
            .any(|v| v.trim() != "none");
    }
    // OpenSSH format: the cipher name is authoritative ("none" = unencrypted).
    PrivateKey::from_openssh(trimmed).is_ok_and(|key| key.is_encrypted())
}

/// The cipher of a traditional (non-EC) PEM key that russh cannot decrypt.
fn unsupported_pem_cipher(contents: &str) -> Option<String> {
    let cipher = contents
        .lines()
        .find_map(|l| l.trim().strip_prefix("DEK-Info:"))?
        .split(',')
        .next()?
        .trim()
        .to_string();
    (cipher != "AES-128-CBC").then_some(cipher)
}

/// A decode error no passphrase can fix: the text is not a key russh can read.
fn is_structural_error(err: &russh::keys::Error) -> bool {
    use russh::keys::Error as E;
    matches!(
        err,
        E::CouldNotReadKey
            | E::UnsupportedKeyType { .. }
            | E::UnknownAlgorithm(_)
            | E::Decode(_)
            | E::IO(_)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::ssh::auth::unattended_tests::ENCRYPTED_KEY;
    use crate::backends::ssh::legacy_pem::tests::{P384_AES128, PASSPHRASE};
    use crate::errors::ConnectFailureKind;

    /// The passphrase of [`ENCRYPTED_KEY`].
    const ENCRYPTED_KEY_PASSPHRASE: &str = "test-passphrase";

    /// A key file in a fresh temp dir; the dir lives as long as the guard.
    fn key_file(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("id_test");
        std::fs::write(&path, contents).expect("write key");
        (dir, path)
    }

    fn load(contents: &str, passphrase: Option<&str>) -> Result<PrivateKey, SessionError> {
        let (_dir, path) = key_file(contents);
        load_private_key(&path, "~/.ssh/id_test", passphrase, false)
    }

    #[test]
    fn openssh_key_with_correct_passphrase_loads() {
        assert!(load(ENCRYPTED_KEY, Some(ENCRYPTED_KEY_PASSPHRASE)).is_ok());
    }

    #[test]
    fn openssh_key_with_wrong_passphrase_is_auth_failed() {
        let err = load(ENCRYPTED_KEY, Some("wrong-passphrase")).expect_err("wrong passphrase");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    #[test]
    fn openssh_key_with_empty_passphrase_is_auth_failed() {
        let err = load(ENCRYPTED_KEY, Some("")).expect_err("empty passphrase");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    #[test]
    fn encrypted_key_without_passphrase_is_auth_failed_when_attended() {
        let err = load(ENCRYPTED_KEY, None).expect_err("no passphrase");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    #[test]
    fn encrypted_key_without_passphrase_needs_interaction_when_unattended() {
        let (_dir, path) = key_file(ENCRYPTED_KEY);
        let err = load_private_key(&path, "~/.ssh/id_test", None, true).expect_err("no passphrase");
        assert_eq!(
            err.connect_failure_kind(),
            Some(ConnectFailureKind::InteractionRequired),
            "got {err:?}"
        );
    }

    #[test]
    fn legacy_pem_ec_key_with_wrong_passphrase_is_auth_failed() {
        assert!(load(P384_AES128, Some(PASSPHRASE)).is_ok());
        let err = load(P384_AES128, Some("wrong-passphrase")).expect_err("wrong passphrase");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
        let err = load(P384_AES128, None).expect_err("no passphrase");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    #[test]
    fn legacy_pem_rsa_key_that_does_not_decrypt_is_auth_failed() {
        // AES-128-CBC is the cipher russh decrypts; garbage ciphertext fails
        // exactly like a wrong passphrase does.
        let pem = "-----BEGIN RSA PRIVATE KEY-----\n\
                   Proc-Type: 4,ENCRYPTED\n\
                   DEK-Info: AES-128-CBC,000102030405060708090A0B0C0D0E0F\n\
                   \n\
                   AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n\
                   -----END RSA PRIVATE KEY-----\n";
        let err = load(pem, Some("wrong-passphrase")).expect_err("garbage");
        assert!(matches!(err, SessionError::AuthFailed), "got {err:?}");
    }

    #[test]
    fn legacy_pem_with_unsupported_cipher_is_spawn_failed() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\n\
                   Proc-Type: 4,ENCRYPTED\n\
                   DEK-Info: DES-EDE3-CBC,0001020304050607\n\
                   \n\
                   AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=\n\
                   -----END RSA PRIVATE KEY-----\n";
        let err = load(pem, Some("any")).expect_err("unsupported cipher");
        match err {
            SessionError::SpawnFailed(msg) => {
                assert!(msg.contains("DES-EDE3-CBC"), "{msg}");
                assert!(msg.contains("~/.ssh/id_test"), "{msg}");
            }
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }

    #[test]
    fn missing_key_file_is_spawn_failed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("does-not-exist");
        let err = load_private_key(&path, "~/.ssh/missing", Some("pass"), false)
            .expect_err("missing file");
        match err {
            SessionError::SpawnFailed(msg) => {
                assert!(msg.contains("cannot read ~/.ssh/missing"), "{msg}");
            }
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }

    #[test]
    fn non_key_file_is_spawn_failed() {
        for passphrase in [None, Some("pass")] {
            let err = load("this is not a private key\n", passphrase).expect_err("not a key");
            assert!(
                matches!(err, SessionError::SpawnFailed(ref m) if m.contains("~/.ssh/id_test")),
                "{passphrase:?}: {err:?}"
            );
        }
    }

    #[test]
    fn encryption_is_read_from_the_key_structure() {
        assert!(is_encrypted_key(ENCRYPTED_KEY));
        assert!(is_encrypted_key(P384_AES128));
        assert!(is_encrypted_key(
            "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"
        ));
        assert!(is_encrypted_key(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n"
        ));
        assert!(!is_encrypted_key(
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"
        ));
        assert!(!is_encrypted_key("not a key"));
    }
}
