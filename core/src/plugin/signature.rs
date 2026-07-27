//! Plugin package **code-signing** primitives (concept
//! `docs/concepts/backlog/plugin-code-signing.html`).
//!
//! A signed `.termihub-plugin` carries one extra well-known root entry,
//! [`SIGNATURE_FILE_NAME`] (`signature.json`), holding a per-entry SHA-256 digest
//! map of *every other* entry plus a single Ed25519 signature over a **canonical
//! signing payload** derived from that map. An unsigned package simply omits the
//! entry, so the format stays backward-compatible and the *presence* of the entry
//! is itself the "is this signed?" signal.
//!
//! This module is host-agnostic and I/O-light: the only I/O is reading entries
//! from a passed-in ZIP reader in [`verify_reader`]. Everything else — the
//! [`PackageSignature`] model, the canonical [`signing_payload`], digest and
//! fingerprint computation, and the Ed25519 [`sign_digests`]/[`verify`]
//! primitives — is pure and exhaustively unit-testable.
//!
//! # What the signature covers
//!
//! The signature is taken over a deterministic byte payload, **not** the JSON
//! text (whitespace and key order would make that non-deterministic):
//!
//! ```text
//! signing_payload =
//!     "termihub-plugin-signature/v1\n"     // domain-separation tag
//!   + "algorithm:ed25519\n"
//!   + "keyId:" + keyId + "\n"
//!   + for each (name, digest) in files, sorted by name:
//!         name + "\0" + digest + "\n"
//! ```
//!
//! Verification recomputes each archive entry's digest and requires an **exact
//! set match**: a digest mismatch, a listed-but-missing entry, *or an unlisted
//! entry present in the archive* all fail. The leading domain-separation tag
//! ensures a plugin signature can never be replayed for another purpose.

use std::collections::BTreeMap;
use std::io::{Read, Seek};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zip::ZipArchive;

use super::package::{
    read_entry_bounded, MANIFEST_FILE_NAME, MAX_DECOMPRESSED_ENTRY_BYTES,
    MAX_DECOMPRESSED_TOTAL_BYTES,
};

/// The well-known signature entry at a signed package's root — present iff the
/// package is signed, sitting beside [`MANIFEST_FILE_NAME`].
pub const SIGNATURE_FILE_NAME: &str = "signature.json";

/// The only [`PackageSignature::format_version`] this host understands. A future
/// version is rejected (blocked, not downgraded to "unsigned") with an
/// actionable "update termiHub" message.
pub const SIGNATURE_FORMAT_VERSION: u32 = 1;

/// The signature algorithm value carried in `signature.json`.
pub const SIGNATURE_ALGORITHM: &str = "ed25519";

/// The per-entry digest algorithm value carried in `signature.json`.
pub const DIGEST_ALGORITHM: &str = "sha256";

/// Domain-separation tag prefixing the canonical signing payload, binding a
/// signature to *this* purpose so it can never be replayed as another.
const DOMAIN_TAG: &str = "termihub-plugin-signature/v1";

/// The `signature.json` document embedded in a signed package.
///
/// Field order and names match the concept's on-disk format. The signature is
/// **not** over this JSON text but over the canonical [`signing_payload`]; the
/// JSON is just the transport for the fields the verifier needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignature {
    /// On-disk format version. Only [`SIGNATURE_FORMAT_VERSION`] is accepted.
    pub format_version: u32,
    /// Signature algorithm — must be [`SIGNATURE_ALGORITHM`].
    pub algorithm: String,
    /// Per-entry digest algorithm — must be [`DIGEST_ALGORITHM`].
    pub digest_algorithm: String,
    /// RFC 3339 timestamp the package was signed at (informational).
    pub signed_at: String,
    /// Base64 of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// `sha256:` + lowercase-hex fingerprint of the public key — the identity the
    /// trust store keys on. Must equal `sha256(publicKey)`.
    pub key_id: String,
    /// Map of every archive entry *except* `signature.json` to its
    /// `sha256:`-prefixed digest.
    pub files: BTreeMap<String, String>,
    /// Base64 of the 64-byte Ed25519 signature over the canonical payload.
    pub signature: String,
}

/// The on-disk output of `termihub-plugin-keygen`: an Ed25519 keypair plus its
/// derived fingerprint and a human label.
///
/// The private key is base64 of the 32-byte Ed25519 seed. Guard this file — it
/// is what proves publisher identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningKeyFile {
    /// Base64 of the 32-byte Ed25519 private key (seed).
    pub private_key: String,
    /// Base64 of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// `sha256:` fingerprint of the public key.
    pub key_id: String,
    /// Human-readable publisher label (e.g. "ACME Terminals").
    pub label: String,
}

/// Everything that can make a signature fail to verify. Every variant is treated
/// as **tampering** by the install gate — never downgraded to "unsigned".
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SignatureError {
    /// The `formatVersion` is one this host does not understand.
    #[error("unsupported signature formatVersion {0}; update termiHub to verify this package")]
    UnsupportedFormatVersion(u32),

    /// The `algorithm` field is not `ed25519`.
    #[error("unsupported signature algorithm `{0}`")]
    UnsupportedAlgorithm(String),

    /// The `digestAlgorithm` field is not `sha256`.
    #[error("unsupported digest algorithm `{0}`")]
    UnsupportedDigestAlgorithm(String),

    /// `signature.json` was not valid JSON / did not match the schema.
    #[error("malformed signature.json: {0}")]
    MalformedJson(String),

    /// A base64 field (public key or signature) did not decode, or decoded to the
    /// wrong length.
    #[error("malformed base64 field: {0}")]
    MalformedEncoding(String),

    /// `keyId` did not equal `sha256(publicKey)` — the embedded identity is
    /// internally inconsistent.
    #[error("keyId does not match the SHA-256 of the public key")]
    KeyIdMismatch,

    /// An archive entry's recomputed digest did not match the signed one.
    #[error("digest mismatch for `{0}`")]
    DigestMismatch(String),

    /// The `files` map lists an entry that is not present in the archive.
    #[error("signed entry `{0}` is missing from the package")]
    MissingEntry(String),

    /// The archive contains an entry the `files` map does not cover — an attacker
    /// cannot append a file the signer never saw.
    #[error("package entry `{0}` is not covered by the signature")]
    ExtraEntry(String),

    /// The Ed25519 signature did not verify against the canonical payload.
    #[error("the Ed25519 signature is not valid for this package")]
    BadSignature,
}

/// The result of checking a package for a signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageVerification {
    /// No `signature.json` entry — the package is unsigned.
    Unsigned,
    /// A signature is present and fully valid. The key is *not* yet checked
    /// against any trust store; that decision belongs to the caller.
    Signed(VerifiedIdentity),
    /// A signature is present but did not verify — treated as tampering.
    Tampered(SignatureError),
}

/// The verified identity of a validly-signed package: enough for the caller to
/// consult a trust store and render a fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedIdentity {
    /// `sha256:` fingerprint — the trust-store key.
    pub key_id: String,
    /// Base64 of the 32-byte public key (so it can be pinned).
    pub public_key: String,
    /// When the package was signed (informational).
    pub signed_at: String,
}

/// A validly-signed archive's verified identity **plus** the signed content map,
/// returned by [`verify_signed_archive`].
///
/// The [`files`](Self::files) map is proven — by the same Ed25519 check
/// [`verify`] runs — to describe the exact bytes of every non-signature entry in
/// the archive it was read from. A caller that then *extracts from that same
/// archive* can re-check each entry it writes against this map, binding the bytes
/// it lands on disk (and later loads) to what was signed — closing a
/// verify-then-extract TOCTOU where extraction re-reads a package that may have
/// changed since the trust gate verified it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSignature {
    /// The verified signing identity (fingerprint, public key, timestamp).
    pub identity: VerifiedIdentity,
    /// The signed per-entry `sha256:` digest map (every entry except
    /// `signature.json`), proven to match the signature over these bytes.
    pub files: BTreeMap<String, String>,
}

/// The outcome of verifying a signature *in place* against an already-opened
/// archive — the borrowed-archive analogue of [`PackageVerification`], but
/// carrying the signed digest map on success (see [`verify_signed_archive`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifiedArchive {
    /// No `signature.json` entry — the archive is unsigned.
    Unsigned,
    /// A signature is present and fully valid; the signed content map is attached.
    Signed(VerifiedSignature),
    /// A signature is present but did not verify — treated as tampering.
    Tampered(SignatureError),
}

/// Compute the `sha256:`-prefixed, lowercase-hex digest of `bytes`.
#[must_use]
pub fn sha256_digest(bytes: &[u8]) -> String {
    let hash = Sha256::digest(bytes);
    format!("{DIGEST_ALGORITHM}:{}", hex::encode(hash))
}

/// Derive the `keyId` fingerprint (`sha256:` + lowercase hex) of a raw public
/// key's bytes.
#[must_use]
pub fn key_id_from_public_key(public_key_bytes: &[u8]) -> String {
    sha256_digest(public_key_bytes)
}

/// Build the canonical, deterministic signing payload from the key id and the
/// per-entry digest map (see the module docs for the exact grammar).
#[must_use]
pub fn signing_payload(key_id: &str, files: &BTreeMap<String, String>) -> Vec<u8> {
    let mut out = String::new();
    out.push_str(DOMAIN_TAG);
    out.push('\n');
    out.push_str("algorithm:");
    out.push_str(SIGNATURE_ALGORITHM);
    out.push('\n');
    out.push_str("keyId:");
    out.push_str(key_id);
    out.push('\n');
    // `BTreeMap` iterates in sorted key order, which is exactly the required
    // "sorted by name" ordering.
    for (name, digest) in files {
        out.push_str(name);
        out.push('\0');
        out.push_str(digest);
        out.push('\n');
    }
    out.into_bytes()
}

/// Generate a fresh Ed25519 publisher keypair with the given label, using the
/// operating-system CSPRNG.
#[must_use]
pub fn generate_keypair(label: &str) -> SigningKeyFile {
    // `rand::rngs::OsRng` implements the `rand_core` traits `ed25519-dalek`'s
    // `rand_core` feature expects.
    let signing_key = SigningKey::generate(&mut rand::rngs::OsRng);
    let public = signing_key.verifying_key();
    let public_bytes = public.to_bytes();
    SigningKeyFile {
        private_key: BASE64.encode(signing_key.to_bytes()),
        public_key: BASE64.encode(public_bytes),
        key_id: key_id_from_public_key(&public_bytes),
        label: label.to_owned(),
    }
}

/// Sign a per-entry digest map with `signing_key`, producing the
/// [`PackageSignature`] to embed. `signed_at` is an RFC 3339 timestamp.
#[must_use]
pub fn sign_digests(
    signing_key: &SigningKey,
    files: BTreeMap<String, String>,
    signed_at: String,
) -> PackageSignature {
    let public_bytes = signing_key.verifying_key().to_bytes();
    let key_id = key_id_from_public_key(&public_bytes);
    let payload = signing_payload(&key_id, &files);
    let signature: Signature = signing_key.sign(&payload);
    PackageSignature {
        format_version: SIGNATURE_FORMAT_VERSION,
        algorithm: SIGNATURE_ALGORITHM.to_owned(),
        digest_algorithm: DIGEST_ALGORITHM.to_owned(),
        signed_at,
        public_key: BASE64.encode(public_bytes),
        key_id,
        files,
        signature: BASE64.encode(signature.to_bytes()),
    }
}

/// Reconstruct an Ed25519 [`SigningKey`] from a base64-encoded 32-byte seed.
pub fn signing_key_from_base64(private_key_b64: &str) -> Result<SigningKey, SignatureError> {
    let bytes = decode_fixed::<32>(private_key_b64, "privateKey")?;
    Ok(SigningKey::from_bytes(&bytes))
}

/// Verify a parsed [`PackageSignature`] against the digest map actually computed
/// from the archive (every entry except `signature.json`).
///
/// Runs, in order: format/algorithm acceptance, `keyId == sha256(publicKey)`,
/// the exact-set digest match, and finally the Ed25519 signature over the
/// canonical payload. Returns the [`VerifiedIdentity`] on success.
pub fn verify(
    sig: &PackageSignature,
    actual_digests: &BTreeMap<String, String>,
) -> Result<VerifiedIdentity, SignatureError> {
    if sig.format_version != SIGNATURE_FORMAT_VERSION {
        return Err(SignatureError::UnsupportedFormatVersion(sig.format_version));
    }
    if sig.algorithm != SIGNATURE_ALGORITHM {
        return Err(SignatureError::UnsupportedAlgorithm(sig.algorithm.clone()));
    }
    if sig.digest_algorithm != DIGEST_ALGORITHM {
        return Err(SignatureError::UnsupportedDigestAlgorithm(
            sig.digest_algorithm.clone(),
        ));
    }

    // The embedded public key must hash to the claimed keyId — the identity has
    // to be internally consistent before it means anything.
    let public_bytes = decode_fixed::<32>(&sig.public_key, "publicKey")?;
    if key_id_from_public_key(&public_bytes) != sig.key_id {
        return Err(SignatureError::KeyIdMismatch);
    }

    // Exact-set digest match: every signed entry present with a matching digest,
    // and no uncovered entry in the archive.
    for (name, expected) in &sig.files {
        match actual_digests.get(name) {
            None => return Err(SignatureError::MissingEntry(name.clone())),
            Some(actual) if actual != expected => {
                return Err(SignatureError::DigestMismatch(name.clone()))
            }
            Some(_) => {}
        }
    }
    for name in actual_digests.keys() {
        if !sig.files.contains_key(name) {
            return Err(SignatureError::ExtraEntry(name.clone()));
        }
    }

    // Finally the cryptographic check over the canonical payload.
    let verifying_key = VerifyingKey::from_bytes(&public_bytes)
        .map_err(|e| SignatureError::MalformedEncoding(format!("publicKey: {e}")))?;
    let sig_bytes = decode_fixed::<64>(&sig.signature, "signature")?;
    let ed_sig = Signature::from_bytes(&sig_bytes);
    let payload = signing_payload(&sig.key_id, &sig.files);
    verifying_key
        .verify(&payload, &ed_sig)
        .map_err(|_| SignatureError::BadSignature)?;

    Ok(VerifiedIdentity {
        key_id: sig.key_id.clone(),
        public_key: sig.public_key.clone(),
        signed_at: sig.signed_at.clone(),
    })
}

/// Open a `.termihub-plugin` from a ZIP reader and classify its signature.
///
/// Returns [`PackageVerification::Unsigned`] when there is no `signature.json`,
/// [`PackageVerification::Signed`] when one is present and fully valid, and
/// [`PackageVerification::Tampered`] for any present-but-invalid signature
/// (malformed JSON, bad base64, keyId mismatch, digest/set mismatch, or a bad
/// signature). A read error on the archive is surfaced as `Tampered` — a package
/// that cannot be read as expected is not treated as trustworthy.
pub fn verify_reader<R: Read + Seek>(
    reader: R,
) -> Result<PackageVerification, zip::result::ZipError> {
    let mut archive = ZipArchive::new(reader)?;
    Ok(match verify_signed_archive(&mut archive)? {
        VerifiedArchive::Unsigned => PackageVerification::Unsigned,
        VerifiedArchive::Signed(v) => PackageVerification::Signed(v.identity),
        VerifiedArchive::Tampered(e) => PackageVerification::Tampered(e),
    })
}

/// Verify a package's embedded signature **in place**, against an already-opened
/// archive, returning the signed content map on success.
///
/// This is the borrowed-archive core that [`verify_reader`] wraps. Exposing it
/// lets an installer verify and then *extract from the very same open archive*,
/// re-checking each extracted entry against the returned
/// [`VerifiedSignature::files`] map — so the bytes it writes (and later loads)
/// are provably the signed ones, not whatever a re-opened path happens to hold.
///
/// Returns [`VerifiedArchive::Unsigned`] when there is no `signature.json`,
/// [`VerifiedArchive::Signed`] when one is present and fully valid, and
/// [`VerifiedArchive::Tampered`] for any present-but-invalid signature. A read
/// error on the archive surfaces as `Err` — a package that cannot be read as
/// expected is not treated as trustworthy.
pub fn verify_signed_archive<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<VerifiedArchive, zip::result::ZipError> {
    // Read the signature entry, if any.
    let raw_signature = match read_entry(archive, SIGNATURE_FILE_NAME)? {
        Some(bytes) => bytes,
        None => return Ok(VerifiedArchive::Unsigned),
    };

    let sig: PackageSignature = match serde_json::from_slice(&raw_signature) {
        Ok(sig) => sig,
        Err(e) => {
            return Ok(VerifiedArchive::Tampered(SignatureError::MalformedJson(
                e.to_string(),
            )))
        }
    };

    // Compute digests of every entry except signature.json itself.
    let actual_digests = digest_entries(archive)?;

    Ok(match verify(&sig, &actual_digests) {
        // On success the exact-set check guarantees `actual_digests == sig.files`,
        // so either map describes the archive's real content; hand back the signed
        // one for the caller to bind extraction against.
        Ok(identity) => VerifiedArchive::Signed(VerifiedSignature {
            identity,
            files: sig.files,
        }),
        Err(e) => VerifiedArchive::Tampered(e),
    })
}

/// Compute the `sha256:` digest of every archive entry except the signature
/// entry itself. Directory entries are skipped (they carry no signed content).
pub fn digest_entries<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<BTreeMap<String, String>, zip::result::ZipError> {
    digest_entries_with_limits(
        archive,
        MAX_DECOMPRESSED_ENTRY_BYTES,
        MAX_DECOMPRESSED_TOTAL_BYTES,
    )
}

/// [`digest_entries`] with explicit decompression limits, so the zip-bomb guard
/// can be exercised in tests without materializing a 128 MB fixture.
fn digest_entries_with_limits<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    per_entry_limit: u64,
    total_limit: u64,
) -> Result<BTreeMap<String, String>, zip::result::ZipError> {
    let mut digests = BTreeMap::new();
    let mut remaining = total_limit;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_owned();
        if name == SIGNATURE_FILE_NAME {
            continue;
        }
        // Bound decompression: an over-budget entry aborts here (surfaced as
        // `ZipError::Io`) instead of exhausting memory (#2046).
        let mut buf = Vec::new();
        read_entry_bounded(&mut entry, per_entry_limit, &mut remaining, &mut buf)?;
        digests.insert(name, sha256_digest(&buf));
    }
    Ok(digests)
}

/// Read a single named entry's bytes from an archive, or `None` if it is absent.
fn read_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Option<Vec<u8>>, zip::result::ZipError> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e),
    };
    // Bound decompression of the named entry (e.g. `signature.json`) so it cannot
    // be a zip-bomb vector before the signature is even parsed (#2046).
    let mut buf = Vec::new();
    let mut remaining = MAX_DECOMPRESSED_ENTRY_BYTES;
    read_entry_bounded(
        &mut entry,
        MAX_DECOMPRESSED_ENTRY_BYTES,
        &mut remaining,
        &mut buf,
    )?;
    Ok(Some(buf))
}

/// Decode a base64 field to exactly `N` bytes, mapping both a decode failure and
/// a wrong length to [`SignatureError::MalformedEncoding`].
fn decode_fixed<const N: usize>(value: &str, field: &str) -> Result<[u8; N], SignatureError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|e| SignatureError::MalformedEncoding(format!("{field}: {e}")))?;
    bytes.try_into().map_err(|v: Vec<u8>| {
        SignatureError::MalformedEncoding(format!("{field}: expected {N} bytes, got {}", v.len()))
    })
}

/// Current time as an RFC 3339 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`), computed
/// without pulling in a date/time crate. Used for the `signedAt` field and the
/// trust store's `addedAt`.
#[must_use]
pub fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_epoch_utc(secs)
}

/// Format Unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (proleptic Gregorian, UTC).
fn format_epoch_utc(secs: u64) -> String {
    let days = secs / 86_400;
    let tod = secs % 86_400;
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Convert a day count since the Unix epoch to a `(year, month, day)` triple
/// (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Assert that `MANIFEST_FILE_NAME` and `SIGNATURE_FILE_NAME` never collide — a
/// compile-adjacent invariant the format relies on.
const _: () = assert!(!str_eq(MANIFEST_FILE_NAME, SIGNATURE_FILE_NAME));

/// `const`-evaluable string equality (there is no `str::eq` in const context).
const fn str_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    /// A signing key with a fixed, reproducible seed for deterministic tests.
    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// Build an in-memory ZIP from `(name, bytes)` entries.
    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zip = ZipWriter::new(Cursor::new(&mut buf));
            let opts = SimpleFileOptions::default();
            for (name, bytes) in entries {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    /// Digest map for a set of entries (as `verify_reader` would compute).
    fn digests_of(entries: &[(&str, &[u8])]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(n, b)| ((*n).to_owned(), sha256_digest(b)))
            .collect()
    }

    /// Sign a set of content entries, then build a ZIP that also contains the
    /// resulting `signature.json`.
    fn signed_zip(key: &SigningKey, entries: &[(&str, &[u8])]) -> Vec<u8> {
        let sig = sign_digests(key, digests_of(entries), "2026-07-26T12:00:00Z".to_owned());
        let sig_json = serde_json::to_vec(&sig).unwrap();
        let mut all: Vec<(&str, &[u8])> = entries.to_vec();
        all.push((SIGNATURE_FILE_NAME, &sig_json));
        zip_of(&all)
    }

    #[test]
    fn sign_then_verify_round_trip() {
        let key = test_key();
        let entries: &[(&str, &[u8])] = &[("manifest.json", b"{}"), ("backend/lib.so", b"\x7fELF")];
        let zip = signed_zip(&key, entries);

        let result = verify_reader(Cursor::new(zip)).unwrap();
        match result {
            PackageVerification::Signed(id) => {
                assert_eq!(
                    id.key_id,
                    key_id_from_public_key(&key.verifying_key().to_bytes())
                );
                assert!(id.key_id.starts_with("sha256:"));
            }
            other => panic!("expected Signed, got {other:?}"),
        }
    }

    #[test]
    fn unsigned_package_is_unsigned() {
        let zip = zip_of(&[("manifest.json", b"{}")]);
        assert_eq!(
            verify_reader(Cursor::new(zip)).unwrap(),
            PackageVerification::Unsigned
        );
    }

    #[test]
    fn key_id_is_sha256_of_public_key() {
        let key = test_key();
        let sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        let expected = sha256_digest(&key.verifying_key().to_bytes());
        assert_eq!(sig.key_id, expected);
        assert!(verify(&sig, &digests_of(&[("a", b"x")])).is_ok());
    }

    #[test]
    fn digest_mismatch_is_rejected() {
        let key = test_key();
        let sig = sign_digests(&key, digests_of(&[("a", b"original")]), "t".into());
        // The archive's actual content differs from what was signed.
        let err = verify(&sig, &digests_of(&[("a", b"tampered")])).unwrap_err();
        assert!(matches!(err, SignatureError::DigestMismatch(n) if n == "a"));
    }

    #[test]
    fn missing_entry_is_rejected() {
        let key = test_key();
        let sig = sign_digests(&key, digests_of(&[("a", b"x"), ("b", b"y")]), "t".into());
        // "b" was signed but is not in the archive.
        let err = verify(&sig, &digests_of(&[("a", b"x")])).unwrap_err();
        assert!(matches!(err, SignatureError::MissingEntry(n) if n == "b"));
    }

    #[test]
    fn extra_entry_is_rejected() {
        let key = test_key();
        let sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        // An entry the signer never saw was appended to the archive.
        let err = verify(&sig, &digests_of(&[("a", b"x"), ("evil.sh", b"rm -rf")])).unwrap_err();
        assert!(matches!(err, SignatureError::ExtraEntry(n) if n == "evil.sh"));
    }

    #[test]
    fn digesting_rejects_an_entry_over_the_decompression_budget() {
        // A single entry whose decompressed size exceeds the per-entry cap must be
        // rejected while reading, not read into memory. Exercised with a tiny cap so
        // no large fixture is needed (#2046).
        let zip = zip_of(&[("manifest.json", b"{}"), ("bomb.bin", &[0u8; 4096])]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let err = digest_entries_with_limits(&mut archive, 64, 1_000_000).unwrap_err();
        assert!(
            matches!(err, zip::result::ZipError::Io(ref e) if e.kind() == std::io::ErrorKind::InvalidData),
            "expected an InvalidData io error, got: {err:?}"
        );
    }

    #[test]
    fn digesting_rejects_when_total_budget_is_exhausted() {
        // Each entry is under the per-entry cap, but together they blow the whole-
        // package budget — the running total must catch it (#2046).
        let zip = zip_of(&[("a.bin", &[0u8; 400]), ("b.bin", &[0u8; 400])]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let err = digest_entries_with_limits(&mut archive, 1_000, 500).unwrap_err();
        assert!(
            matches!(err, zip::result::ZipError::Io(ref e) if e.kind() == std::io::ErrorKind::InvalidData),
            "expected an InvalidData io error, got: {err:?}"
        );
    }

    #[test]
    fn digesting_accepts_content_within_the_budget() {
        // A normal package well under both budgets still digests successfully — the
        // guard does not reject legitimate content.
        let entries: &[(&str, &[u8])] = &[("manifest.json", b"{}"), ("lib.so", b"\x7fELF....")];
        let zip = zip_of(entries);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let digests = digest_entries_with_limits(
            &mut archive,
            MAX_DECOMPRESSED_ENTRY_BYTES,
            MAX_DECOMPRESSED_TOTAL_BYTES,
        )
        .expect("content within budget must digest");
        assert_eq!(digests, digests_of(entries));
    }

    #[test]
    fn bad_signature_is_rejected() {
        let key = test_key();
        let mut sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        // Corrupt the signature bytes (still valid base64 of 64 bytes).
        sig.signature = BASE64.encode([0u8; 64]);
        let err = verify(&sig, &digests_of(&[("a", b"x")])).unwrap_err();
        assert!(matches!(err, SignatureError::BadSignature));
    }

    #[test]
    fn key_id_not_matching_public_key_is_rejected() {
        let key = test_key();
        let mut sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        sig.key_id = "sha256:deadbeef".to_owned();
        let err = verify(&sig, &digests_of(&[("a", b"x")])).unwrap_err();
        assert!(matches!(err, SignatureError::KeyIdMismatch));
    }

    #[test]
    fn unknown_format_version_is_rejected() {
        let key = test_key();
        let mut sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        sig.format_version = 2;
        let err = verify(&sig, &digests_of(&[("a", b"x")])).unwrap_err();
        assert!(matches!(err, SignatureError::UnsupportedFormatVersion(2)));
    }

    #[test]
    fn unknown_algorithm_is_rejected() {
        let key = test_key();
        let mut sig = sign_digests(&key, digests_of(&[("a", b"x")]), "t".into());
        sig.algorithm = "rsa".to_owned();
        assert!(matches!(
            verify(&sig, &digests_of(&[("a", b"x")])).unwrap_err(),
            SignatureError::UnsupportedAlgorithm(_)
        ));
    }

    #[test]
    fn malformed_signature_json_is_tampered() {
        let mut all: Vec<(&str, &[u8])> = vec![("manifest.json", b"{}")];
        all.push((SIGNATURE_FILE_NAME, b"{ not valid json"));
        let zip = zip_of(&all);
        assert!(matches!(
            verify_reader(Cursor::new(zip)).unwrap(),
            PackageVerification::Tampered(SignatureError::MalformedJson(_))
        ));
    }

    #[test]
    fn tampered_content_via_reader_is_tampered() {
        let key = test_key();
        // Sign one content, then swap the signed entry's bytes in the archive.
        let sig = sign_digests(&key, digests_of(&[("manifest.json", b"good")]), "t".into());
        let sig_json = serde_json::to_vec(&sig).unwrap();
        let zip = zip_of(&[("manifest.json", b"EVIL"), (SIGNATURE_FILE_NAME, &sig_json)]);
        assert!(matches!(
            verify_reader(Cursor::new(zip)).unwrap(),
            PackageVerification::Tampered(SignatureError::DigestMismatch(_))
        ));
    }

    #[test]
    fn keygen_produces_consistent_fingerprint() {
        let kf = generate_keypair("ACME Terminals");
        assert_eq!(kf.label, "ACME Terminals");
        // Reconstructed key round-trips and its public fingerprint matches.
        let key = signing_key_from_base64(&kf.private_key).unwrap();
        let pub_b64 = BASE64.encode(key.verifying_key().to_bytes());
        assert_eq!(pub_b64, kf.public_key);
        assert_eq!(kf.key_id, sha256_digest(&key.verifying_key().to_bytes()));
    }

    #[test]
    fn signing_payload_is_deterministic_and_sorted() {
        // Insertion order must not matter — BTreeMap sorts by name.
        let mut a = BTreeMap::new();
        a.insert("b".to_owned(), "sha256:2".to_owned());
        a.insert("a".to_owned(), "sha256:1".to_owned());
        let p = signing_payload("sha256:k", &a);
        let text = String::from_utf8(p).unwrap();
        assert!(
            text.starts_with("termihub-plugin-signature/v1\nalgorithm:ed25519\nkeyId:sha256:k\n")
        );
        assert!(text.contains("a\0sha256:1\n"));
        // "a" must come before "b".
        assert!(text.find("a\0sha256:1").unwrap() < text.find("b\0sha256:2").unwrap());
    }

    #[test]
    fn epoch_formatting_is_correct() {
        assert_eq!(format_epoch_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_epoch_utc(1_785_067_200), "2026-07-26T12:00:00Z");
    }
}
