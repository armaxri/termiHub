//! Loading passphrase-protected **legacy PEM** EC private keys.
//!
//! OpenSSL's "traditional" PEM encryption stores an EC key as
//! `-----BEGIN EC PRIVATE KEY-----` (SEC1) with a `Proc-Type: 4,ENCRYPTED`
//! header and a `DEK-Info: AES-128-CBC,<iv>` line, deriving the cipher key from
//! the passphrase via OpenSSL's MD5-based `EVP_BytesToKey`.
//!
//! russh 0.61 recognises the PEM label but its `decode_pkcs5` decrypts the blob
//! and then parses the plaintext **only as PKCS#1 RSA** (it carries a literal
//! `// TODO: presumably pkcs5 could contain non-RSA keys?`). So a SEC1 EC key
//! fails to load with a misleading "Pkcs1: expected INTEGER, got OCTET STRING".
//! Before russh's migration off libssh2 these keys were handled by libssh2
//! directly; this module restores that support natively.
//!
//! The decryption mirrors russh's own `decode_pkcs5` (MD5 KDF + AES-CBC, PKCS#7
//! padding); the difference is we parse the plaintext as a SEC1 `ECPrivateKey`
//! and build an [`ssh_key::PrivateKey`] instead of assuming RSA.

use aes::cipher::{block_padding::Pkcs7, BlockModeDecrypt, KeyIvInit};
use russh::keys::ssh_key::private::EcdsaKeypair;
use russh::keys::ssh_key::PrivateKey;
use sec1::der::{asn1::OctetStringRef, Reader, SliceReader};
use thiserror::Error;

const PEM_BEGIN: &str = "-----BEGIN EC PRIVATE KEY-----";
const PEM_END: &str = "-----END EC PRIVATE KEY-----";

/// Errors from loading a legacy-PEM EC key.
#[derive(Debug, Error)]
pub enum LegacyPemError {
    /// The text is not a traditional encrypted `EC PRIVATE KEY` PEM block.
    #[error("not an encrypted EC PRIVATE KEY PEM")]
    NotEncryptedEcPem,
    /// The PEM block is malformed (missing DEK-Info, bad base64/hex, …).
    #[error("malformed encrypted EC PEM: {0}")]
    Malformed(String),
    /// The `DEK-Info` cipher is not one we support.
    #[error("unsupported PEM cipher: {0}")]
    UnsupportedCipher(String),
    /// Decryption failed — almost always a wrong passphrase.
    #[error("decryption failed (wrong passphrase?)")]
    Decrypt,
    /// The decrypted bytes are not a SEC1 key on a supported NIST curve.
    #[error("unsupported or invalid EC key (expected NIST P-256/384/521)")]
    UnsupportedCurve,
}

/// Whether `pem` looks like a traditional **encrypted** `EC PRIVATE KEY` block.
///
/// Cheap structural check used to decide whether the [`load`] fallback applies;
/// unencrypted SEC1 keys are handled by russh directly and are not our concern.
pub fn is_encrypted_ec_pem(pem: &str) -> bool {
    pem.contains(PEM_BEGIN) && pem.contains("Proc-Type:") && pem.contains("ENCRYPTED")
}

/// Decrypt and parse a passphrase-protected legacy-PEM EC key into a russh key.
pub fn load(pem: &str, passphrase: &str) -> Result<PrivateKey, LegacyPemError> {
    let (cipher, iv, body) = parse_encrypted_pem(pem)?;
    let der = decrypt(&cipher, &iv, passphrase.as_bytes(), &body)?;
    sec1_der_to_private_key(&der)
}

/// Split an encrypted `EC PRIVATE KEY` block into (DEK cipher, IV, ciphertext).
fn parse_encrypted_pem(pem: &str) -> Result<(String, Vec<u8>, Vec<u8>), LegacyPemError> {
    if !is_encrypted_ec_pem(pem) {
        return Err(LegacyPemError::NotEncryptedEcPem);
    }
    let start = pem
        .find(PEM_BEGIN)
        .ok_or(LegacyPemError::NotEncryptedEcPem)?;
    let end = pem.find(PEM_END).ok_or(LegacyPemError::NotEncryptedEcPem)?;
    let inner = &pem[start + PEM_BEGIN.len()..end];

    // Header lines carry a `:` (Proc-Type, DEK-Info); the base64 ciphertext body
    // never does — so we classify by that rather than the blank separator line
    // (there is also a blank line between the BEGIN marker and the headers).
    let mut cipher_iv: Option<(String, Vec<u8>)> = None;
    let mut body = String::new();
    for line in inner.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("DEK-Info:") {
            let (name, iv_hex) = rest
                .trim()
                .split_once(',')
                .ok_or_else(|| LegacyPemError::Malformed("DEK-Info has no IV".into()))?;
            let iv = hex::decode(iv_hex.trim())
                .map_err(|e| LegacyPemError::Malformed(format!("bad IV hex: {e}")))?;
            cipher_iv = Some((name.trim().to_string(), iv));
        } else if !line.contains(':') {
            body.push_str(line); // base64 ciphertext line
        }
        // Any other header line (e.g. Proc-Type) is ignored.
    }

    let (cipher, iv) =
        cipher_iv.ok_or_else(|| LegacyPemError::Malformed("missing DEK-Info header".into()))?;
    let ciphertext = data_encoding::BASE64
        .decode(body.as_bytes())
        .map_err(|e| LegacyPemError::Malformed(format!("bad base64 body: {e}")))?;
    Ok((cipher, iv, ciphertext))
}

/// Decrypt the PEM body, deriving the key with OpenSSL's MD5 `EVP_BytesToKey`.
fn decrypt(
    cipher: &str,
    iv: &[u8],
    passphrase: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, LegacyPemError> {
    if iv.len() != 16 {
        return Err(LegacyPemError::Malformed(format!(
            "expected a 16-byte IV, got {}",
            iv.len()
        )));
    }
    // EVP_BytesToKey uses the first 8 IV bytes as the KDF salt.
    let salt = &iv[..8];

    // `decrypt_padded` mutates the buffer in place and returns the unpadded slice.
    macro_rules! cbc_decrypt {
        ($block:ty, $key_len:expr) => {{
            let key = evp_bytes_to_key(passphrase, salt, $key_len);
            let dec = cbc::Decryptor::<$block>::new_from_slices(&key, iv)
                .map_err(|_| LegacyPemError::Decrypt)?;
            let mut buf = ciphertext.to_vec();
            let plain = dec
                .decrypt_padded::<Pkcs7>(&mut buf)
                .map_err(|_| LegacyPemError::Decrypt)?;
            plain.to_vec()
        }};
    }

    Ok(match cipher {
        "AES-128-CBC" => cbc_decrypt!(aes::Aes128, 16),
        "AES-192-CBC" => cbc_decrypt!(aes::Aes192, 24),
        "AES-256-CBC" => cbc_decrypt!(aes::Aes256, 32),
        other => return Err(LegacyPemError::UnsupportedCipher(other.to_string())),
    })
}

/// OpenSSL's legacy `EVP_BytesToKey` (MD5, 1 iteration), producing `key_len` bytes.
///
/// `key_i = MD5(key_{i-1} || passphrase || salt)`, concatenated until long enough.
fn evp_bytes_to_key(passphrase: &[u8], salt: &[u8], key_len: usize) -> Vec<u8> {
    let mut key = Vec::with_capacity(key_len);
    let mut block: Vec<u8> = Vec::new();
    while key.len() < key_len {
        let mut ctx = md5::Context::new();
        ctx.consume(&block);
        ctx.consume(passphrase);
        ctx.consume(salt);
        block = ctx.compute().0.to_vec();
        key.extend_from_slice(&block);
    }
    key.truncate(key_len);
    key
}

/// Parse a decrypted SEC1 `ECPrivateKey` DER into a russh [`PrivateKey`].
///
/// We read only the private scalar and pick the curve by its length (32/48/66
/// bytes → P-256/384/521). This deliberately ignores the DER's curve parameters,
/// so it accepts both *named-curve* and *explicit-parameter* SEC1 keys (OpenSSL
/// emits the latter for `ecparam -genkey` without `-named_curve`, and the
/// elliptic-curve crates' `from_sec1_der` rejects those). The public key is
/// re-derived from the scalar rather than trusted from the file.
///
/// `public`/`private` are built with `.into()` exactly as `EcdsaKeypair::random`
/// does — `From<PublicKey>` / `From<SecretKey>` give the right field types. The
/// curve is chosen by the scalar's byte length: SEC1 may drop leading zero bytes,
/// so we match a *range* up to each field size and left-pad before `from_slice`
/// (which wants exactly the field length).
fn sec1_der_to_private_key(der: &[u8]) -> Result<PrivateKey, LegacyPemError> {
    let scalar = sec1_private_scalar(der)?;
    let len = scalar.len();
    let keypair = if len <= 32 {
        let sk = p256::SecretKey::from_slice(&left_pad::<32>(&scalar))
            .map_err(|_| LegacyPemError::Decrypt)?;
        EcdsaKeypair::NistP256 {
            public: sk.public_key().into(),
            private: sk.into(),
        }
    } else if len <= 48 {
        let sk = p384::SecretKey::from_slice(&left_pad::<48>(&scalar))
            .map_err(|_| LegacyPemError::Decrypt)?;
        EcdsaKeypair::NistP384 {
            public: sk.public_key().into(),
            private: sk.into(),
        }
    } else if len <= 66 {
        let sk = p521::SecretKey::from_slice(&left_pad::<66>(&scalar))
            .map_err(|_| LegacyPemError::Decrypt)?;
        EcdsaKeypair::NistP521 {
            public: sk.public_key().into(),
            private: sk.into(),
        }
    } else {
        return Err(LegacyPemError::UnsupportedCurve);
    };
    Ok(PrivateKey::from(keypair))
}

/// Right-align `scalar` into a fixed `N`-byte big-endian buffer (zero-padded).
fn left_pad<const N: usize>(scalar: &[u8]) -> [u8; N] {
    let mut buf = [0u8; N];
    buf[N - scalar.len()..].copy_from_slice(scalar);
    buf
}

/// Pull the `privateKey` scalar out of a SEC1 `ECPrivateKey` DER.
///
/// Reads only `version` + `privateKey OCTET STRING` and skips the optional
/// `[0] parameters` / `[1] publicKey` fields, so it works for both named-curve
/// and explicit-parameter keys (the full `sec1::EcPrivateKey` decoder rejects
/// the latter).
fn sec1_private_scalar(der: &[u8]) -> Result<Vec<u8>, LegacyPemError> {
    let mut reader = SliceReader::new(der).map_err(|_| LegacyPemError::Decrypt)?;
    reader
        .sequence(|r| {
            r.tlv_bytes()?; // version INTEGER (== 1), discarded
            let scalar = r.decode::<&OctetStringRef>()?.as_bytes().to_vec();
            // Consume any trailing optional fields so the SEQUENCE reads cleanly.
            while !r.is_finished() {
                r.tlv_bytes()?;
            }
            Ok(scalar)
        })
        .map_err(|_: sec1::der::Error| LegacyPemError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve};

    // Shared passphrase for every committed test key (see tests/fixtures README).
    const PASSPHRASE: &str = "testpass123";

    // Self-contained AES-128-CBC PEM/SEC1 keys (passphrase `testpass123`) for the
    // two curves the fallback exists for. Kept inline rather than read from
    // `tests/fixtures/ssh-keys/` because those fixtures are OpenSSH-format (russh
    // loads them directly) — these exercise the legacy-PEM path specifically.
    const P384_AES128: &str = r"-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,DF8026B0D98D1566B0EA00199159ECBA

ZOEf5fijOFqQauMOyoAmGXbUm7S+5pu1h3U1QqskD6USelPeSW+x33eqAqk3Mi/G
zC+TsarXwqsUxLitzhrM2zY+es7BYzdbxZC5/LZ1XA0SPGZgju9NdHpd+ULNUzWP
dbmKfM3UlNPlEhx1N1ushVfv8IEbr5pVJJEE30+rK5SZyI0gY6c8QRIvIyPwL7gG
TkTWkNXIa0HlE/VfB3j+KuOCo7KZZaC4BXVTWpWjK889Bq4wCVcnCrjVQbATvufq
ksaP40EcyqMVdvZWhs2E9hj70wGxH+v2ZK1IANHtQe72ufLYO52VEUXtC0rJl/W/
7sqZYiXqwQAenVj5a12mzYZhMxK9g9hDKqjUslaOuXdA61CaU2AZ1YWqk6lAdzSO
lquZZgzlQTAfBTe2Ok2Huh8bHO1rkZPDYjNH7GNDIswzm/bxvySuhwvqQH0kgnCM
TmdUInm/2jrvxSbtxAN7GMyVJZnrd7O16dQssNCj4Z+ruvPXpWHpBhl4ekly09vw
V2hcIbkT8oFeIBqRsyUrybDb7QiNXV0FpwQOb1Zly5dT7ZGmMYdtUjWd/YaWdiVZ
+jqQxPBc8uFStboVtxDK/VUUPkYUhyXb4T1eOgSD+zXfXxJMoo+/fSB4rnEeqe+P
EUAgh3LmxvBt5C97gNqSVdEUZ1ACgaKjqTMy8H8o4KU=
-----END EC PRIVATE KEY-----
";
    const P521_AES128: &str = r"-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,5112809B7663F8488D9F9960A5AB873F

CiHxXonHhl8A3YZPTs7EjQweI+fgcoitaMkuXUA/GyY0h6AB2y3C3KOpXoyDUTU9
2h46yGRn7dgxEeLB8tetju6jdHwbCJCBw2mWRLueUfTvTVlPbMb5GgB5CE15UUYe
UcDOoicEy2ySVjdNrPF5q27UAQ4BRDfBSD0y1WkuvxtKQK3V3hbam6/p/HKd7auk
eGiT+vhIHj5WCaI8zueI276fp3Ke1wrU1ZP6d/T9hnxporxTlt28sfDEPytVcraR
1dk9eeuGttg1SLHxmcFYG17+s3oUxc1G8p/xtEKqSOW71Y6wlGSTV/Iufw0tNsHK
OUZ97sXsIJp5cfYQmGFB4PIHE/WGBK5P4whrsSQYd0HKfjjy6EwRMS6fAzXrBQc7
wkL3XFzNw4ToNMQQRIKzLp2+sSBU2HI1cQp/6Lpa6A4dVqr+keU8juQN+fD5N0DU
4HQGettNRNdrvBRoL/DOld9H8rfhRvAUkm+4F23JZbAAd8Bc9iQ15X8R0b34xo1D
PFdzwh980wnov/x8gYTRN9eu6HTT2N5224XNXzjRlkz8KCHICworhwBkRElbMFWm
5cqrTjKg3EgMzdUvMkyo0Psbvg4GPDhZ67zvB9ArkwzZGFPjHIOH9QUf7Anq2SQn
ih2CS0J3p5UazXA3H1fs26RaWklc+V3IZvas5QOx74d2A5Mpm6DpxgCyx0dRJJu1
5DoVzUcQylRz57F/eFi2FOA9YeOZd+WSM0jFDbCIsCZycdwKPFpkHg3odB/j8xjQ
bJ+XQ/RF62PlSyZ057SemRW/MNMtkcRp6ddO9ebkrr2oxS3UBY8O3AM1bOJUPEaY
cGfAeYvu2iAN7+RkoA3/oDs9ExD/53STLUv6OCE13ZNIIAaNpTtlENp/fTeNikRv
kBwBMkhEcEfw3SxxgMVxdg==
-----END EC PRIVATE KEY-----
";

    // An AES-256-CBC P-256 key (modern OpenSSL default cipher) — exercises the
    // multi-round EVP_BytesToKey path the AES-128 fixtures don't.
    const P256_AES256: &str = r"-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-256-CBC,EC90B1B3EF50AEA84EF535A718DD556A

Vt26zjYsGYHqY3U2H1J3zWdFiNJCCEuA52f3TnxHcb39SpXo1wS2jmv99uZL1fKp
pVFHdRvCSO+eesCC5pFGL0dsId55F99Owsv9x6uLDCIRfDHxnotCNJKweTRrw/Cq
YzFrVtZtPSv2X+vDFPgp/l77tqnSOAb8Zvt4un8hgp0=
-----END EC PRIVATE KEY-----
";

    fn curve_of(pem: &str) -> EcdsaCurve {
        match load(pem, PASSPHRASE).expect("key should load").algorithm() {
            Algorithm::Ecdsa { curve } => curve,
            other => panic!("expected an ECDSA key, got {other:?}"),
        }
    }

    #[test]
    fn detects_encrypted_ec_pem() {
        assert!(is_encrypted_ec_pem(P384_AES128));
        assert!(!is_encrypted_ec_pem(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n"
        ));
        // Unencrypted SEC1 keys are russh's job, not ours.
        assert!(!is_encrypted_ec_pem(
            "-----BEGIN EC PRIVATE KEY-----\nMHc...\n"
        ));
    }

    #[test]
    fn loads_aes128_p384() {
        assert_eq!(curve_of(P384_AES128), EcdsaCurve::NistP384);
    }

    #[test]
    fn loads_aes128_p521() {
        assert_eq!(curve_of(P521_AES128), EcdsaCurve::NistP521);
    }

    #[test]
    fn loads_aes256_p256() {
        assert_eq!(curve_of(P256_AES256), EcdsaCurve::NistP256);
    }

    #[test]
    fn wrong_passphrase_is_rejected() {
        // A bad passphrase yields garbage plaintext: PKCS#7 unpadding or SEC1
        // parsing fails — either way an error, never a key.
        assert!(load(P384_AES128, "wrong-passphrase").is_err());
    }

    #[test]
    fn non_ec_pem_is_declined() {
        assert!(matches!(
            load("-----BEGIN OPENSSH PRIVATE KEY-----\n", PASSPHRASE),
            Err(LegacyPemError::NotEncryptedEcPem)
        ));
    }
}
