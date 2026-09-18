use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, Result};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

/// Argon2id memory cost in KiB (64 MiB).
pub const ARGON2_MEMORY_COST: u32 = 65536;
/// Argon2id iteration count.
pub const ARGON2_TIME_COST: u32 = 3;
/// Argon2id parallelism degree.
pub const ARGON2_PARALLELISM: u32 = 1;
/// Length of the random salt in bytes.
pub const SALT_LEN: usize = 32;
/// Length of the AES-256-GCM nonce in bytes.
pub const NONCE_LEN: usize = 12;
/// Current envelope format version — every new encryption is written at this
/// version.
///
/// # Versioning & migration contract (PER-008)
///
/// The envelope format is versioned so the on-disk crypto (KDF, AEAD, layout)
/// can be hardened over time without orphaning existing vaults. **Reads accept
/// the range [`MIN_SUPPORTED_ENVELOPE_VERSION`]`..=`[`ENVELOPE_VERSION`]; writes
/// always use [`ENVELOPE_VERSION`].** An older-but-supported vault is therefore
/// transparently re-sealed at the current version on its next save
/// ("upgrade on write") — it is never eagerly rewritten on a read-only unlock.
///
/// To introduce a new format `N` safely:
/// 1. Bump `ENVELOPE_VERSION` to `N`.
/// 2. Teach [`decrypt_with_password`] (and the unlock path in `master_password`)
///    to decrypt an envelope whose `version` is `N`. The version is bound as the
///    AEAD AAD, so a version-`M` envelope MUST authenticate with `M`'s AAD, never
///    the current one — always build it via [`aad_for_version`].
/// 3. Leave `MIN_SUPPORTED_ENVELOPE_VERSION` covering every format still meant to
///    be readable; raise it only to *drop* support for a format — a one-way,
///    data-losing decision, after which a store at a dropped version is
///    unreadable ("no longer supported").
///
/// A store written by a *newer* build (`version > ENVELOPE_VERSION`) — the
/// auto-update-then-rollback case — is rejected with a distinct "written by a
/// newer version" error, never as corruption, so a downgrade is recoverable by
/// re-updating rather than looking like data loss.
pub const ENVELOPE_VERSION: u32 = 1;

/// Oldest envelope format version this build can still read.
///
/// Reads accept `MIN_SUPPORTED_ENVELOPE_VERSION..=ENVELOPE_VERSION`. Today that
/// range is just `{1}`; the constant exists so a future [`ENVELOPE_VERSION`]
/// bump keeps older-but-supported vaults readable. See the migration contract on
/// [`ENVELOPE_VERSION`].
pub const MIN_SUPPORTED_ENVELOPE_VERSION: u32 = 1;

/// The AEAD additional-authenticated-data for an envelope of the given format
/// `version`: a single version byte.
///
/// The version is bound into the AEAD tag, so decryption of a version-`N`
/// envelope MUST authenticate with `N`'s AAD — not the current
/// [`ENVELOPE_VERSION`] — or an otherwise-valid unlock fails authentication.
/// Encryption always uses `ENVELOPE_VERSION`. A version-1 envelope yields the
/// single byte `[1]`, byte-for-byte identical to the original hardcoded AAD, so
/// every existing `credentials.enc` stays readable across this change.
pub fn aad_for_version(version: u32) -> [u8; 1] {
    [version as u8]
}

/// How a stored envelope's format `version` relates to what this build reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionSupport {
    /// Within `MIN_SUPPORTED_ENVELOPE_VERSION..=ENVELOPE_VERSION` — readable.
    Supported,
    /// Below `MIN_SUPPORTED_ENVELOPE_VERSION` — support was dropped; terminal.
    TooOld,
    /// Above `ENVELOPE_VERSION` — written by a newer build (downgrade/rollback).
    Newer,
}

/// Classify a stored envelope `version` against this build's readable range.
///
/// This is the single gate every read path (unlock, import) uses so the two
/// distinct rejection cases — too-old vs. newer-than-this-build — stay
/// consistent everywhere. See the migration contract on [`ENVELOPE_VERSION`].
pub fn classify_envelope_version(version: u32) -> VersionSupport {
    if version < MIN_SUPPORTED_ENVELOPE_VERSION {
        VersionSupport::TooOld
    } else if version > ENVELOPE_VERSION {
        VersionSupport::Newer
    } else {
        VersionSupport::Supported
    }
}

/// User-facing message for a store written by a newer build than this one.
///
/// Deliberately distinct from any "corrupt" wording: this is the recoverable
/// auto-update-then-rollback case, fixed by updating termiHub — not data loss.
pub fn newer_version_message(version: u32) -> String {
    format!(
        "credential store was written by a newer version of termiHub \
         (format version {version}, this build reads up to {ENVELOPE_VERSION}) \
         — update termiHub to unlock"
    )
}

/// User-facing message for a store whose format is older than this build reads.
pub fn too_old_version_message(version: u32) -> String {
    format!(
        "credential store format version {version} is no longer supported \
         (this build reads version {MIN_SUPPORTED_ENVELOPE_VERSION} and newer)"
    )
}

/// Upper bound on the Argon2 memory cost (KiB) accepted from a stored envelope.
///
/// The decrypt path derives from the params carried *in the file*, so a
/// corrupted or tampered envelope must not be able to force an unbounded
/// allocation on unlock. 1 GiB is far above any sane setting while still
/// leaving generous room to strengthen the KDF over time.
pub const ARGON2_MAX_MEMORY_COST: u32 = 1_048_576;
/// Upper bound on the Argon2 time cost accepted from a stored envelope.
pub const ARGON2_MAX_TIME_COST: u32 = 64;
/// Upper bound on the Argon2 parallelism accepted from a stored envelope.
pub const ARGON2_MAX_PARALLELISM: u32 = 16;

/// Encrypted envelope format used for on-disk storage and export files.
///
/// Uses camelCase for JSON serialization (new format), but accepts
/// snake_case aliases for backward compatibility with existing
/// `credentials.enc` files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedEnvelope {
    pub version: u32,
    pub kdf: KdfParams,
    pub nonce: String,
    pub data: String,
}

/// Key derivation function parameters stored alongside the ciphertext.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub algorithm: String,
    #[serde(alias = "memory_cost")]
    pub memory_cost: u32,
    #[serde(alias = "time_cost")]
    pub time_cost: u32,
    pub parallelism: u32,
    pub salt: String,
}

/// Argon2id cost parameters used to derive a key.
///
/// These are persisted in every [`EncryptedEnvelope`] so the KDF can be
/// strengthened over time without breaking existing data: the decrypt side
/// derives from *the params the file was written with*, read back via
/// [`from_kdf`](Self::from_kdf), not from the compiled-in constants. Without
/// this, raising [`ARGON2_MEMORY_COST`]/[`ARGON2_TIME_COST`] would silently
/// render every existing vault and export undecryptable (#2362).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Cost {
    /// Memory cost in KiB.
    pub memory_cost: u32,
    /// Iteration count.
    pub time_cost: u32,
    /// Parallelism degree.
    pub parallelism: u32,
}

impl Argon2Cost {
    /// The current compiled-in cost parameters used for all new encryptions.
    pub const fn current() -> Self {
        Self {
            memory_cost: ARGON2_MEMORY_COST,
            time_cost: ARGON2_TIME_COST,
            parallelism: ARGON2_PARALLELISM,
        }
    }

    /// Read and validate the cost parameters from a stored envelope's KDF block.
    ///
    /// Rejects an unrecognised `algorithm` and any value outside the accepted
    /// bounds, so a corrupt or tampered envelope cannot select a foreign KDF or
    /// force an unbounded allocation on unlock.
    pub fn from_kdf(kdf: &KdfParams) -> Result<Self> {
        if !kdf.algorithm.eq_ignore_ascii_case("argon2id") {
            anyhow::bail!("Unsupported KDF algorithm: {}", kdf.algorithm);
        }
        let cost = Self {
            memory_cost: kdf.memory_cost,
            time_cost: kdf.time_cost,
            parallelism: kdf.parallelism,
        };
        cost.validate()?;
        Ok(cost)
    }

    /// Ensure the parameters are non-zero and within the accepted ceilings.
    fn validate(&self) -> Result<()> {
        if self.memory_cost == 0 || self.memory_cost > ARGON2_MAX_MEMORY_COST {
            anyhow::bail!(
                "Argon2 memory cost out of range: {} (allowed 1..={ARGON2_MAX_MEMORY_COST})",
                self.memory_cost
            );
        }
        if self.time_cost == 0 || self.time_cost > ARGON2_MAX_TIME_COST {
            anyhow::bail!(
                "Argon2 time cost out of range: {} (allowed 1..={ARGON2_MAX_TIME_COST})",
                self.time_cost
            );
        }
        if self.parallelism == 0 || self.parallelism > ARGON2_MAX_PARALLELISM {
            anyhow::bail!(
                "Argon2 parallelism out of range: {} (allowed 1..={ARGON2_MAX_PARALLELISM})",
                self.parallelism
            );
        }
        Ok(())
    }
}

/// Derive a 256-bit key from a password and salt using Argon2id with the
/// given [`Argon2Cost`].
pub fn derive_key_with_cost(password: &str, salt: &[u8], cost: &Argon2Cost) -> Result<[u8; 32]> {
    let params = argon2::Params::new(cost.memory_cost, cost.time_cost, cost.parallelism, Some(32))
        .map_err(|e| anyhow::anyhow!("Invalid Argon2 parameters: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("Argon2 key derivation failed: {e}"))?;
    Ok(key)
}

/// Derive a 256-bit key from a password and salt using Argon2id with the
/// current compiled-in cost parameters.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    derive_key_with_cost(password, salt, &Argon2Cost::current())
}

/// Encrypt plaintext bytes with a password using Argon2id + AES-256-GCM,
/// deriving the key with the given [`Argon2Cost`].
///
/// Generates a fresh random salt and nonce, records the cost parameters in the
/// envelope so decryption can reproduce the key, and returns the sealed
/// ciphertext. Prefer [`encrypt_with_password`] unless you specifically need to
/// pin non-default cost parameters.
pub fn encrypt_with_cost(
    password: &str,
    plaintext: &[u8],
    cost: &Argon2Cost,
) -> Result<EncryptedEnvelope> {
    cost.validate()?;

    let mut salt = vec![0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let key = derive_key_with_cost(password, &salt, cost)?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key).context("Failed to create cipher")?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Bind the current format version into the AEAD tag. Reads authenticate with
    // the envelope's own version (see `aad_for_version`), so writes must seal
    // with the version they stamp on the envelope — always `ENVELOPE_VERSION`.
    let aad = aad_for_version(ENVELOPE_VERSION);
    let payload = aes_gcm::aead::Payload {
        msg: plaintext,
        aad: &aad,
    };
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;

    Ok(EncryptedEnvelope {
        version: ENVELOPE_VERSION,
        kdf: KdfParams {
            algorithm: "argon2id".to_string(),
            salt: BASE64.encode(&salt),
            memory_cost: cost.memory_cost,
            time_cost: cost.time_cost,
            parallelism: cost.parallelism,
        },
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(&ciphertext),
    })
}

/// Encrypt plaintext bytes with a password using Argon2id + AES-256-GCM.
///
/// Generates a fresh random salt and nonce, derives an encryption key from
/// the password with the current compiled-in cost parameters, then returns the
/// sealed ciphertext inside an [`EncryptedEnvelope`].
pub fn encrypt_with_password(password: &str, plaintext: &[u8]) -> Result<EncryptedEnvelope> {
    encrypt_with_cost(password, plaintext, &Argon2Cost::current())
}

/// A decryption failure carrying a locale-invariant discriminator.
///
/// Callers (e.g. the import command) react to a wrong password without matching
/// the human-readable English message, so classification survives localization
/// or a reword of the text (I18N-010).
///
/// [`WrongPassword`](DecryptError::WrongPassword) is the AEAD authentication
/// failure: the password was wrong — or, indistinguishably, the ciphertext was
/// tampered with or corrupted, which is handled identically. [`Other`] covers
/// structural failures (unsupported version, malformed base64, invalid KDF
/// params) that no password can fix.
///
/// [`Other`]: DecryptError::Other
#[derive(Debug, thiserror::Error)]
pub enum DecryptError {
    /// AEAD authentication failed: wrong password or corrupted/tampered data.
    #[error("Decryption failed — wrong password or corrupted data")]
    WrongPassword,
    /// A structural decrypt failure unrelated to the password.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Decrypt an [`EncryptedEnvelope`] using the given password.
///
/// Returns the decrypted plaintext bytes, or a typed [`DecryptError`]. A wrong
/// password (or tampered ciphertext) surfaces as [`DecryptError::WrongPassword`]
/// so callers can classify it without matching the English message; every other
/// failure is [`DecryptError::Other`].
pub fn decrypt_with_password(
    password: &str,
    envelope: &EncryptedEnvelope,
) -> std::result::Result<Vec<u8>, DecryptError> {
    // Accept any version in the supported range; reject the two out-of-range
    // cases with distinct, non-corruption messages (PER-008). A newer-than-this
    // -build envelope is the recoverable rollback case, not data loss.
    match classify_envelope_version(envelope.version) {
        VersionSupport::Supported => {}
        VersionSupport::TooOld => {
            return Err(anyhow::anyhow!(too_old_version_message(envelope.version)).into());
        }
        VersionSupport::Newer => {
            return Err(anyhow::anyhow!(newer_version_message(envelope.version)).into());
        }
    }

    let salt = BASE64
        .decode(&envelope.kdf.salt)
        .context("Invalid salt encoding")?;
    let nonce_bytes = BASE64
        .decode(&envelope.nonce)
        .context("Invalid nonce encoding")?;
    let ciphertext = BASE64
        .decode(&envelope.data)
        .context("Invalid ciphertext encoding")?;

    // Validate lengths before use: a wrong-length nonce would panic inside
    // `Nonce::from_slice`, and a corrupted salt would silently derive a wrong
    // key. Surface both as recoverable errors instead (#2049).
    if salt.len() != SALT_LEN {
        return Err(anyhow::anyhow!(
            "Invalid salt length: expected {SALT_LEN}, got {}",
            salt.len()
        )
        .into());
    }
    if nonce_bytes.len() != NONCE_LEN {
        return Err(anyhow::anyhow!(
            "Invalid nonce length: expected {NONCE_LEN}, got {}",
            nonce_bytes.len()
        )
        .into());
    }

    // Derive the key from the cost parameters carried *in the envelope*, not the
    // compiled-in constants — this is what lets the KDF be strengthened without
    // orphaning existing data. The params are validated first so a tampered file
    // cannot select a foreign KDF or force an unbounded allocation (#2362).
    let cost = Argon2Cost::from_kdf(&envelope.kdf)?;
    let key = derive_key_with_cost(password, &salt, &cost)?;

    let cipher = Aes256Gcm::new_from_slice(&key).context("Failed to create cipher")?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Authenticate with the envelope's OWN version, not the current one: the
    // version is bound as AAD, so a supported-but-older envelope must use its
    // own version byte or a valid unlock would fail authentication (PER-008).
    let aad = aad_for_version(envelope.version);
    let payload = aes_gcm::aead::Payload {
        msg: &ciphertext,
        aad: &aad,
    };
    // AEAD authentication failure: the derived key (hence the password) is wrong,
    // or the ciphertext was tampered/corrupted — indistinguishable and handled
    // identically. Surface the locale-invariant `WrongPassword` discriminator so
    // callers classify by variant, not by this English message (I18N-010).
    let mut plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| DecryptError::WrongPassword)?;

    let result = plaintext.clone();
    plaintext.zeroize();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_round_trip() {
        let password = "test-password-123";
        let plaintext = b"Hello, world! This is secret data.";

        let envelope = encrypt_with_password(password, plaintext).unwrap();
        let decrypted = decrypt_with_password(password, &envelope).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn wrong_password_returns_typed_variant() {
        // A wrong password must surface the locale-invariant `WrongPassword`
        // variant, so callers classify by type rather than by the English
        // message (I18N-010) — a reworded or localized message must not change
        // this outcome.
        let plaintext = b"secret data";
        let envelope = encrypt_with_password("correct-password", plaintext).unwrap();

        let result = decrypt_with_password("wrong-password", &envelope);
        assert!(
            matches!(result, Err(DecryptError::WrongPassword)),
            "wrong password must classify as DecryptError::WrongPassword, got: {result:?}"
        );
    }

    #[test]
    fn structural_failures_do_not_classify_as_wrong_password() {
        // A structural failure (here: an unsupported envelope version) is not a
        // password problem, so it must be `Other`, never `WrongPassword`.
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.version = 99;

        let result = decrypt_with_password("pw", &envelope);
        assert!(
            matches!(result, Err(DecryptError::Other(_))),
            "a structural failure must classify as DecryptError::Other, got: {result:?}"
        );
    }

    #[test]
    fn envelope_serializes_to_camel_case() {
        let envelope = encrypt_with_password("pw", b"data").unwrap();
        let json = serde_json::to_string(&envelope).unwrap();

        assert!(json.contains("\"memoryCost\""));
        assert!(json.contains("\"timeCost\""));
        assert!(!json.contains("\"memory_cost\""));
        assert!(!json.contains("\"time_cost\""));
    }

    #[test]
    fn envelope_deserializes_from_snake_case() {
        // Simulate the old on-disk format with snake_case field names
        let json = r#"{
            "version": 1,
            "kdf": {
                "algorithm": "argon2id",
                "salt": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "memory_cost": 65536,
                "time_cost": 3,
                "parallelism": 1
            },
            "nonce": "AAAAAAAAAAAAAAAA",
            "data": "AAAA"
        }"#;

        let envelope: EncryptedEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.kdf.memory_cost, 65536);
        assert_eq!(envelope.kdf.time_cost, 3);
    }

    #[test]
    fn envelope_deserializes_from_camel_case() {
        let json = r#"{
            "version": 1,
            "kdf": {
                "algorithm": "argon2id",
                "salt": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "memoryCost": 65536,
                "timeCost": 3,
                "parallelism": 1
            },
            "nonce": "AAAAAAAAAAAAAAAA",
            "data": "AAAA"
        }"#;

        let envelope: EncryptedEnvelope = serde_json::from_str(json).unwrap();
        assert_eq!(envelope.kdf.memory_cost, 65536);
        assert_eq!(envelope.kdf.time_cost, 3);
    }

    #[test]
    fn wrong_length_nonce_reports_error() {
        // A corrupted/truncated nonce must surface a recoverable error, not
        // panic inside `Nonce::from_slice` (#2049).
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.nonce = BASE64.encode([0u8; NONCE_LEN - 1]);

        let result = decrypt_with_password("pw", &envelope);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("nonce"));
    }

    #[test]
    fn wrong_length_salt_reports_error() {
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.kdf.salt = BASE64.encode([0u8; SALT_LEN - 1]);

        let result = decrypt_with_password("pw", &envelope);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("salt"));
    }

    #[test]
    fn decrypt_uses_envelope_kdf_params_not_compiled_constants() {
        // A file sealed with Argon2 params different from the compiled-in
        // constants — as a hardened future build, or another build, would
        // write — must still decrypt with the correct password. Decryption
        // derives the key from the envelope's stored params, not `ARGON2_*`
        // (#2362); before the fix this failed with a wrong-password error.
        let password = "test-password";
        let plaintext = b"secret data";
        let cost = Argon2Cost {
            memory_cost: ARGON2_MEMORY_COST,
            time_cost: ARGON2_TIME_COST + 2,
            parallelism: ARGON2_PARALLELISM,
        };
        let envelope = encrypt_with_cost(password, plaintext, &cost).unwrap();
        assert_eq!(envelope.kdf.time_cost, ARGON2_TIME_COST + 2);

        let decrypted = decrypt_with_password(password, &envelope).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_rejects_out_of_range_kdf_params() {
        // Honoring file-supplied params must not let a tampered envelope force an
        // unbounded allocation on unlock (#2362).
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.kdf.memory_cost = ARGON2_MAX_MEMORY_COST + 1;

        let result = decrypt_with_password("pw", &envelope);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("memory cost"));
    }

    #[test]
    fn decrypt_rejects_unknown_kdf_algorithm() {
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.kdf.algorithm = "scrypt".to_string();

        let result = decrypt_with_password("pw", &envelope);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .to_lowercase()
            .contains("algorithm"));
    }

    // --- PER-008: safe envelope version-range migration ---

    #[test]
    fn newer_version_reports_distinct_message_not_corruption() {
        // A store written by a NEWER build (version > ENVELOPE_VERSION) — the
        // auto-update-then-rollback case — must surface a distinct "newer
        // version, update to unlock" message, NOT look like corruption. This is
        // the key UX fix: a recoverable downgrade must not read as data loss.
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.version = ENVELOPE_VERSION + 1;

        let msg = decrypt_with_password("pw", &envelope)
            .unwrap_err()
            .to_string()
            .to_lowercase();
        assert!(
            msg.contains("newer version"),
            "expected a distinct newer-version message, got: {msg}"
        );
        assert!(
            !msg.contains("corrupt"),
            "a downgrade must not read as corruption, got: {msg}"
        );
    }

    #[test]
    fn too_old_version_reports_no_longer_supported() {
        // A store whose format predates the minimum supported version is
        // terminal: report it clearly as no-longer-supported.
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.version = 0;

        let msg = decrypt_with_password("pw", &envelope)
            .unwrap_err()
            .to_string()
            .to_lowercase();
        assert!(
            msg.contains("no longer supported"),
            "expected a no-longer-supported message, got: {msg}"
        );
    }

    #[test]
    fn min_supported_version_is_accepted_on_read() {
        // The range check must accept the minimum supported version. Today
        // MIN == CURRENT == 1, so a normally-written envelope both is at the
        // minimum and round-trips; the assertion documents the invariant that
        // MIN is a readable member of the range, not an off-by-one boundary.
        assert_eq!(
            classify_envelope_version(MIN_SUPPORTED_ENVELOPE_VERSION),
            VersionSupport::Supported
        );
        assert_eq!(
            classify_envelope_version(ENVELOPE_VERSION),
            VersionSupport::Supported
        );

        let envelope = encrypt_with_password("pw", b"data").unwrap();
        assert_eq!(envelope.version, ENVELOPE_VERSION);
        assert_eq!(decrypt_with_password("pw", &envelope).unwrap(), b"data");
    }

    #[test]
    fn classify_envelope_version_boundaries() {
        assert_eq!(classify_envelope_version(0), VersionSupport::TooOld);
        assert_eq!(
            classify_envelope_version(ENVELOPE_VERSION + 1),
            VersionSupport::Newer
        );
    }

    #[test]
    fn aad_for_version_1_matches_legacy_single_byte() {
        // Backward-compat invariant: version-1 envelopes were sealed with the
        // original hardcoded AAD of `[1]`. The version-derived AAD MUST reproduce
        // that exact byte, or every existing `credentials.enc` becomes
        // undecryptable. Do not "fix" this to `version.to_le_bytes()`.
        assert_eq!(aad_for_version(1), [1u8]);
        assert_eq!(aad_for_version(ENVELOPE_VERSION), [ENVELOPE_VERSION as u8]);
    }

    #[test]
    fn writes_always_use_current_envelope_version() {
        // Upgrade-on-write contract: encryption always stamps ENVELOPE_VERSION,
        // so a store read at a supported-but-older version is transparently
        // re-sealed at the current version on its next save.
        let envelope = encrypt_with_password("pw", b"data").unwrap();
        assert_eq!(envelope.version, ENVELOPE_VERSION);
    }
}
