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
/// Current envelope format version.
pub const ENVELOPE_VERSION: u32 = 1;
/// Additional authenticated data: single version byte.
pub const AAD: &[u8] = &[1];

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

/// Derive a 256-bit key from a password and salt using Argon2id.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let params = argon2::Params::new(
        ARGON2_MEMORY_COST,
        ARGON2_TIME_COST,
        ARGON2_PARALLELISM,
        Some(32),
    )
    .map_err(|e| anyhow::anyhow!("Invalid Argon2 parameters: {e}"))?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("Argon2 key derivation failed: {e}"))?;
    Ok(key)
}

/// Encrypt plaintext bytes with a password using Argon2id + AES-256-GCM.
///
/// Generates a fresh random salt and nonce, derives an encryption key from
/// the password, then returns the sealed ciphertext inside an
/// [`EncryptedEnvelope`].
pub fn encrypt_with_password(password: &str, plaintext: &[u8]) -> Result<EncryptedEnvelope> {
    let mut salt = vec![0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);

    let key = derive_key(password, &salt)?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key).context("Failed to create cipher")?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload = aes_gcm::aead::Payload {
        msg: plaintext,
        aad: AAD,
    };
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {e}"))?;

    Ok(EncryptedEnvelope {
        version: ENVELOPE_VERSION,
        kdf: KdfParams {
            algorithm: "argon2id".to_string(),
            salt: BASE64.encode(&salt),
            memory_cost: ARGON2_MEMORY_COST,
            time_cost: ARGON2_TIME_COST,
            parallelism: ARGON2_PARALLELISM,
        },
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(&ciphertext),
    })
}

/// Decrypt an [`EncryptedEnvelope`] using the given password.
///
/// Returns the decrypted plaintext bytes, or an error if the password is
/// wrong or the envelope is corrupted.
pub fn decrypt_with_password(password: &str, envelope: &EncryptedEnvelope) -> Result<Vec<u8>> {
    if envelope.version != ENVELOPE_VERSION {
        anyhow::bail!(
            "Unsupported encrypted envelope version: {}",
            envelope.version
        );
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

    let key = derive_key(password, &salt)?;

    let cipher = Aes256Gcm::new_from_slice(&key).context("Failed to create cipher")?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload = aes_gcm::aead::Payload {
        msg: &ciphertext,
        aad: AAD,
    };
    let mut plaintext = cipher
        .decrypt(nonce, payload)
        .map_err(|_| anyhow::anyhow!("Decryption failed — wrong password or corrupted data"))?;

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
    fn wrong_password_fails() {
        let plaintext = b"secret data";
        let envelope = encrypt_with_password("correct-password", plaintext).unwrap();

        let result = decrypt_with_password("wrong-password", &envelope);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("wrong password"));
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
    fn unsupported_version_fails() {
        let mut envelope = encrypt_with_password("pw", b"data").unwrap();
        envelope.version = 99;

        let result = decrypt_with_password("pw", &envelope);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Unsupported"));
    }
}
