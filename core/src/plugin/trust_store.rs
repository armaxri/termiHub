//! The publisher **trust store** (concept
//! `docs/concepts/backlog/plugin-code-signing.html` → "Key Distribution & Trust
//! Anchoring").
//!
//! A valid signature only proves "the holder of key *K* produced this package,
//! unaltered" — it says nothing about whether *K* should be trusted. That is this
//! module's job. The store is a host-side JSON file,
//! `<app-data>/plugins/trust-store.json`, listing the publisher keys the user has
//! pinned, plus a seed of **bundled first-party keys** that ship pre-trusted.
//!
//! Trust is anchored **trust-on-first-use (TOFU) + explicit pinning**: the first
//! install of a signed-but-unknown key shows its fingerprint and asks the user to
//! trust it; accepting [`pin`](TrustStore::pin)s the key so later updates from the
//! same key verify silently. This mirrors the SSH / remote-desktop host-key trust
//! pattern already in the codebase.
//!
//! Because it lives under the same plugins root every other plugin file uses, it
//! inherits the app-data + portable-mode redirection automatically — no separate
//! path logic.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use std::sync::{LazyLock, Once};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::signature::{key_id_from_public_key, now_rfc3339};
use crate::ed25519_pem::parse_public_keys_pem;

/// The trust-store file name, alongside the manager's other plugin state files.
pub const TRUST_STORE_FILE_NAME: &str = "trust-store.json";

/// How a trusted key came to be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "kebab-case")]
pub enum TrustSource {
    /// A termiHub-official key that ships pre-trusted in the app. Cannot be
    /// revoked, so official plugins never regress to a warning.
    Bundled,
    /// A key the user pinned on first use (TOFU). Revocable.
    UserPinned,
}

/// One trusted publisher key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct TrustedPublisher {
    /// `sha256:` fingerprint of the public key — the store's primary key.
    pub key_id: String,
    /// Base64 of the 32-byte Ed25519 public key.
    pub public_key: String,
    /// Human-readable label (e.g. "ACME Terminals").
    pub label: String,
    /// Whether the key is bundled (immutable) or user-pinned (revocable).
    pub source: TrustSource,
    /// RFC 3339-ish timestamp the key was added (bundled keys report the load
    /// time). Informational.
    pub added_at: String,
}

/// Errors mutating or persisting the trust store.
#[derive(Debug, Error)]
pub enum TrustStoreError {
    /// A filesystem operation on the store failed.
    #[error("trust-store I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The store file could not be (de)serialized.
    #[error("trust-store serialization error: {0}")]
    Serde(String),

    /// An attempt to revoke a bundled first-party key, which is immutable.
    #[error("bundled first-party key `{0}` cannot be revoked")]
    BundledKeyImmutable(String),

    /// An attempt to pin a key under a bundled first-party key id with a
    /// different public key. The compiled-in key is authoritative.
    #[error(
        "key id `{0}` belongs to a bundled first-party publisher; a different key cannot be \
         pinned under it"
    )]
    BundledKeyConflict(String),
}

/// The persisted `trust-store.json` document: only user-pinned keys are written
/// (bundled keys are re-seeded on every load).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrustStoreDoc {
    #[serde(default)]
    publishers: Vec<TrustedPublisher>,
}

/// Marker line of the committed placeholder first-party key file.
pub const FIRST_PARTY_KEY_PLACEHOLDER_MARKER: &str = "TERMIHUB-FIRST-PARTY-PLUGIN-KEY-PLACEHOLDER";

/// Label shown for the compiled-in first-party publisher in Settings → Plugins →
/// Trusted Publishers.
pub const FIRST_PARTY_PUBLISHER_LABEL: &str = "termiHub (first-party)";

/// The committed first-party publisher key file, compiled in (#3980). Same PEM
/// SubjectPublicKeyInfo format as the agent-update and plugin-index keys
/// ([`crate::ed25519_pem`]); more than one block allows a rotation overlap.
const EMBEDDED_FIRST_PARTY_KEYS_PEM: &str =
    include_str!("../../../plugins/keys/first-party-publisher.pub.pem");

/// The bundled first-party keys seeded into every trust store, parsed once from
/// [`EMBEDDED_FIRST_PARTY_KEYS_PEM`].
///
/// # Trust anchor (#3980)
///
/// A key listed here is the immutable root of plugin trust: it is seeded as
/// [`TrustSource::Bundled`] on every load, so a first-party plugin signed with it
/// verifies as `Verified` without any user pin, and no edit to
/// `trust-store.json` can remove it, shadow it with another key, or revoke it.
/// That is what closes the gap the load-time check (#2796) leaves open: an
/// attacker who can write the app-data directory can pin their *own* key, but
/// cannot forge a key compiled into the binary.
///
/// # Placeholder posture: TOFU only
///
/// Until the maintainer runs `scripts/internal/setup-plugin-publisher-key.sh`,
/// the committed file is a marked placeholder with no `PUBLIC KEY` block and
/// this list is **empty**. Behaviour is then exactly the pre-#3980 posture:
/// every trusted key is a user (TOFU) pin in `trust-store.json`, the load-time
/// check stops a swapped-and-re-signed library whose signer is not pinned, but
/// not an attacker who can rewrite app data. [`TrustStore::load`] logs this once
/// and [`first_party_trust_anchor_configured`] reports it.
static BUNDLED_PUBLISHERS: LazyLock<Vec<BundledKey>> =
    LazyLock::new(|| bundled_keys_from_pem(EMBEDDED_FIRST_PARTY_KEYS_PEM));

/// Whether this build carries a real first-party publisher key (`false` while
/// the committed key file is still the placeholder).
#[must_use]
pub fn first_party_trust_anchor_configured() -> bool {
    !BUNDLED_PUBLISHERS.is_empty()
}

/// Turn a trusted-key PEM file into bundled entries: one per distinct valid
/// Ed25519 block, keyed by its `sha256:` fingerprint exactly as package
/// signatures carry it. A placeholder (no block) yields an empty list.
fn bundled_keys_from_pem(pem: &str) -> Vec<BundledKey> {
    let mut out: Vec<BundledKey> = Vec::new();
    for key in parse_public_keys_pem(pem) {
        let bytes = key.to_bytes();
        let key_id = key_id_from_public_key(&bytes);
        if out.iter().any(|k| k.key_id == key_id) {
            continue;
        }
        out.push(BundledKey {
            key_id,
            public_key: BASE64.encode(bytes),
            label: FIRST_PARTY_PUBLISHER_LABEL.to_owned(),
        });
    }
    out
}

/// Report the placeholder posture once per process, so a log shows why no
/// first-party publisher is listed.
fn report_anchor_posture_once(bundled: &[BundledKey]) {
    static REPORTED: Once = Once::new();
    REPORTED.call_once(|| {
        if bundled.is_empty() {
            tracing::info!(
                "plugin trust: no first-party publisher key compiled in (placeholder \
                 plugins/keys/first-party-publisher.pub.pem); publisher trust is \
                 trust-on-first-use pins only"
            );
        } else {
            tracing::info!(
                "plugin trust: {} first-party publisher key(s) compiled in as bundled anchors",
                bundled.len()
            );
        }
    });
}

/// A bundled key entry, derived from the compiled-in PEM file.
#[derive(Debug, Clone)]
struct BundledKey {
    key_id: String,
    public_key: String,
    label: String,
}

impl BundledKey {
    fn to_publisher(&self, added_at: &str) -> TrustedPublisher {
        TrustedPublisher {
            key_id: self.key_id.clone(),
            public_key: self.public_key.clone(),
            label: self.label.clone(),
            source: TrustSource::Bundled,
            added_at: added_at.to_owned(),
        }
    }
}

/// The publisher trust store: an in-memory index keyed by `keyId`, backed by a
/// JSON file. Bundled keys are always present (re-seeded on load); user-pinned
/// keys persist.
#[derive(Debug, Clone)]
pub struct TrustStore {
    path: PathBuf,
    publishers: BTreeMap<String, TrustedPublisher>,
}

impl TrustStore {
    /// Load the trust store rooted at `plugins_root` (its file is
    /// `plugins_root/trust-store.json`), seeding the bundled first-party keys. A
    /// missing file yields a store with only the bundled keys.
    pub fn load(plugins_root: &Path) -> Result<Self, TrustStoreError> {
        report_anchor_posture_once(&BUNDLED_PUBLISHERS);
        Self::load_with_bundled(plugins_root, &BUNDLED_PUBLISHERS)
    }

    /// [`load`](Self::load) with the bundled seed parsed from an explicit PEM
    /// key file — lets tests exercise the real-key path with a generated key.
    #[cfg(test)]
    pub(crate) fn load_with_bundled_pem(
        plugins_root: &Path,
        pem: &str,
    ) -> Result<Self, TrustStoreError> {
        Self::load_with_bundled(plugins_root, &bundled_keys_from_pem(pem))
    }

    /// [`load`](Self::load) with an explicit bundled-key seed — the seam tests
    /// use to inject a known bundled key without shipping one.
    fn load_with_bundled(
        plugins_root: &Path,
        bundled: &[BundledKey],
    ) -> Result<Self, TrustStoreError> {
        let path = plugins_root.join(TRUST_STORE_FILE_NAME);
        let doc: TrustStoreDoc = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| TrustStoreError::Serde(e.to_string()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => TrustStoreDoc::default(),
            Err(e) => return Err(TrustStoreError::Io(e)),
        };

        let mut publishers = BTreeMap::new();
        // Seed bundled keys first; they are authoritative and cannot be shadowed
        // by a persisted entry claiming the same id.
        let now = now_rfc3339();
        for key in bundled {
            publishers.insert(key.key_id.clone(), key.to_publisher(&now));
        }
        for pub_key in doc.publishers {
            // A persisted key that collides with a bundled id is ignored — the
            // bundled entry wins and stays immutable.
            publishers
                .entry(pub_key.key_id.clone())
                .or_insert_with(|| TrustedPublisher {
                    source: TrustSource::UserPinned,
                    ..pub_key
                });
        }

        Ok(Self { path, publishers })
    }

    /// A store with only the bundled first-party keys, without reading any file —
    /// the safe fallback the manager uses when the on-disk store cannot be read
    /// (a corrupt file must not make an untrusted key read as trusted).
    pub(crate) fn bundled_only(plugins_root: &Path) -> Self {
        let now = now_rfc3339();
        let publishers = BUNDLED_PUBLISHERS
            .iter()
            .map(|key| (key.key_id.clone(), key.to_publisher(&now)))
            .collect();
        Self {
            path: plugins_root.join(TRUST_STORE_FILE_NAME),
            publishers,
        }
    }

    /// Whether a key id is trusted (bundled or user-pinned).
    #[must_use]
    pub fn is_trusted(&self, key_id: &str) -> bool {
        self.publishers.contains_key(key_id)
    }

    /// The label for a trusted key id, if any.
    #[must_use]
    pub fn label_for(&self, key_id: &str) -> Option<&str> {
        self.publishers.get(key_id).map(|p| p.label.as_str())
    }

    /// Every trusted publisher, sorted by label then key id (bundled and pinned
    /// together — the source field distinguishes them for the UI).
    #[must_use]
    pub fn list(&self) -> Vec<TrustedPublisher> {
        let mut out: Vec<_> = self.publishers.values().cloned().collect();
        out.sort_by(|a, b| a.label.cmp(&b.label).then(a.key_id.cmp(&b.key_id)));
        out
    }

    /// Pin a user key (TOFU accept). Idempotent for an already-pinned key;
    /// pinning a key id that is already **bundled** with the same public key is
    /// a no-op (it is already trusted and immutable), while pinning a
    /// *different* key under a bundled id is refused
    /// ([`TrustStoreError::BundledKeyConflict`]). Persists the store.
    pub fn pin(
        &mut self,
        key_id: &str,
        public_key: &str,
        label: &str,
    ) -> Result<(), TrustStoreError> {
        if let Some(existing) = self.publishers.get(key_id) {
            if existing.source == TrustSource::Bundled {
                if existing.public_key == public_key {
                    return Ok(());
                }
                return Err(TrustStoreError::BundledKeyConflict(key_id.to_owned()));
            }
        }
        self.publishers.insert(
            key_id.to_owned(),
            TrustedPublisher {
                key_id: key_id.to_owned(),
                public_key: public_key.to_owned(),
                label: label.to_owned(),
                source: TrustSource::UserPinned,
                added_at: now_rfc3339(),
            },
        );
        self.save()
    }

    /// Revoke (remove) a user-pinned key. Removing trust does not uninstall
    /// already-installed plugins; it only affects future install/update gates.
    /// A bundled key cannot be revoked
    /// ([`TrustStoreError::BundledKeyImmutable`]); an unknown key id is a no-op.
    pub fn revoke(&mut self, key_id: &str) -> Result<(), TrustStoreError> {
        match self.publishers.get(key_id).map(|p| p.source) {
            Some(TrustSource::Bundled) => {
                Err(TrustStoreError::BundledKeyImmutable(key_id.to_owned()))
            }
            Some(TrustSource::UserPinned) => {
                self.publishers.remove(key_id);
                self.save()
            }
            None => Ok(()),
        }
    }

    /// Persist the user-pinned keys to disk (bundled keys are not written; they
    /// are re-seeded on load). Written atomically via a temp-file rename.
    fn save(&self) -> Result<(), TrustStoreError> {
        let doc = TrustStoreDoc {
            publishers: self
                .publishers
                .values()
                .filter(|p| p.source == TrustSource::UserPinned)
                .cloned()
                .collect(),
        };
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(&doc)
            .map_err(|e| TrustStoreError::Serde(e.to_string()))?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn bundled() -> Vec<BundledKey> {
        vec![BundledKey {
            key_id: "sha256:bundledaaaa".to_owned(),
            public_key: "QUJD".to_owned(),
            label: "termiHub Official".to_owned(),
        }]
    }

    fn store_with_bundled(root: &Path) -> TrustStore {
        TrustStore::load_with_bundled(root, &bundled()).unwrap()
    }

    #[test]
    fn empty_store_trusts_nothing_by_default() {
        let tmp = TempDir::new().unwrap();
        let store = TrustStore::load(tmp.path()).unwrap();
        assert!(!store.is_trusted("sha256:anything"));
        assert!(store
            .list()
            .iter()
            .all(|p| p.source == TrustSource::Bundled));
    }

    #[test]
    fn pin_makes_key_trusted_and_persists() {
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load(tmp.path()).unwrap();
        store.pin("sha256:abc", "cHVia2V5", "ACME").unwrap();
        assert!(store.is_trusted("sha256:abc"));
        assert_eq!(store.label_for("sha256:abc"), Some("ACME"));

        // A fresh load over the same root sees the pinned key.
        let reloaded = TrustStore::load(tmp.path()).unwrap();
        assert!(reloaded.is_trusted("sha256:abc"));
        assert_eq!(
            reloaded.list()[0].source,
            TrustSource::UserPinned,
            "persisted keys reload as user-pinned"
        );
    }

    #[test]
    fn revoke_removes_a_user_pinned_key() {
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load(tmp.path()).unwrap();
        store.pin("sha256:abc", "cHVia2V5", "ACME").unwrap();
        store.revoke("sha256:abc").unwrap();
        assert!(!store.is_trusted("sha256:abc"));

        // Persisted removal survives a reload.
        assert!(!TrustStore::load(tmp.path())
            .unwrap()
            .is_trusted("sha256:abc"));
    }

    #[test]
    fn revoke_unknown_key_is_a_noop() {
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load(tmp.path()).unwrap();
        assert!(store.revoke("sha256:ghost").is_ok());
    }

    #[test]
    fn bundled_key_is_trusted_and_immutable() {
        let tmp = TempDir::new().unwrap();
        let mut store = store_with_bundled(tmp.path());
        assert!(store.is_trusted("sha256:bundledaaaa"));
        assert_eq!(
            store.label_for("sha256:bundledaaaa"),
            Some("termiHub Official")
        );

        // Cannot be revoked.
        assert!(matches!(
            store.revoke("sha256:bundledaaaa"),
            Err(TrustStoreError::BundledKeyImmutable(_))
        ));
        assert!(store.is_trusted("sha256:bundledaaaa"));
    }

    #[test]
    fn bundled_keys_are_reseeded_and_not_persisted() {
        let tmp = TempDir::new().unwrap();
        {
            let mut store = store_with_bundled(tmp.path());
            // Pin a user key so the file gets written.
            store.pin("sha256:userkey", "cHVia2V5", "User").unwrap();
        }
        // The persisted file must contain only the user-pinned key, not the
        // bundled one (which is re-seeded from code on load).
        let raw = std::fs::read_to_string(tmp.path().join(TRUST_STORE_FILE_NAME)).unwrap();
        assert!(raw.contains("sha256:userkey"));
        assert!(!raw.contains("sha256:bundledaaaa"));

        // Reloading with the bundled seed restores both.
        let store = store_with_bundled(tmp.path());
        assert!(store.is_trusted("sha256:bundledaaaa"));
        assert!(store.is_trusted("sha256:userkey"));
    }

    #[test]
    fn pinning_a_bundled_id_is_a_noop_and_stays_bundled() {
        let tmp = TempDir::new().unwrap();
        let mut store = store_with_bundled(tmp.path());
        store.pin("sha256:bundledaaaa", "QUJD", "Renamed").unwrap();
        // Still bundled, still the original label — a pin cannot override it.
        assert_eq!(
            store.label_for("sha256:bundledaaaa"),
            Some("termiHub Official")
        );
        assert!(matches!(
            store.revoke("sha256:bundledaaaa"),
            Err(TrustStoreError::BundledKeyImmutable(_))
        ));
    }

    // --- Compiled-in first-party anchor (#3980) ---

    /// A throwaway test key (never a real one) and its PEM key file, as the
    /// setup script writes it.
    fn test_key_pem(seed: u8) -> (ed25519_dalek::SigningKey, String) {
        let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let pem = format!(
            "# test first-party key\n{}",
            crate::ed25519_pem::public_key_pem(&key.verifying_key())
        );
        (key, pem)
    }

    fn ids_of(key: &ed25519_dalek::SigningKey) -> (String, String) {
        let bytes = key.verifying_key().to_bytes();
        (key_id_from_public_key(&bytes), BASE64.encode(bytes))
    }

    #[test]
    fn committed_key_file_is_a_placeholder_or_a_real_key() {
        let keys = bundled_keys_from_pem(EMBEDDED_FIRST_PARTY_KEYS_PEM);
        if EMBEDDED_FIRST_PARTY_KEYS_PEM.contains(FIRST_PARTY_KEY_PLACEHOLDER_MARKER) {
            assert!(
                !EMBEDDED_FIRST_PARTY_KEYS_PEM.contains("-----BEGIN PUBLIC KEY-----"),
                "the placeholder marker must not sit next to a real key block"
            );
            assert!(keys.is_empty());
            assert!(!first_party_trust_anchor_configured());
        } else {
            assert!(
                !keys.is_empty(),
                "a non-placeholder key file must hold a valid key"
            );
            assert!(first_party_trust_anchor_configured());
            let tmp = TempDir::new().unwrap();
            let store = TrustStore::load(tmp.path()).unwrap();
            for key in &keys {
                assert!(store.is_trusted(&key.key_id));
            }
        }
    }

    #[test]
    fn placeholder_key_file_seeds_no_bundled_publisher() {
        let placeholder = format!("# placeholder\n# {FIRST_PARTY_KEY_PLACEHOLDER_MARKER}\n");
        assert!(bundled_keys_from_pem(&placeholder).is_empty());

        // TOFU behaviour is unchanged: nothing trusted until the user pins.
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load_with_bundled_pem(tmp.path(), &placeholder).unwrap();
        assert!(store.list().is_empty());
        store.pin("sha256:abc", "cHVia2V5", "ACME").unwrap();
        assert!(store.is_trusted("sha256:abc"));
        store.revoke("sha256:abc").unwrap();
        assert!(!store.is_trusted("sha256:abc"));
    }

    #[test]
    fn real_key_file_seeds_an_immutable_bundled_publisher() {
        let (key, pem) = test_key_pem(7);
        let (key_id, public_key) = ids_of(&key);
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load_with_bundled_pem(tmp.path(), &pem).unwrap();

        let listed = store.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].key_id, key_id);
        assert_eq!(listed[0].public_key, public_key);
        assert_eq!(listed[0].source, TrustSource::Bundled);
        assert_eq!(listed[0].label, FIRST_PARTY_PUBLISHER_LABEL);
        assert!(matches!(
            store.revoke(&key_id),
            Err(TrustStoreError::BundledKeyImmutable(_))
        ));
        // Re-pinning the same key is a harmless no-op that writes nothing.
        store.pin(&key_id, &public_key, "Renamed").unwrap();
        assert_eq!(store.label_for(&key_id), Some(FIRST_PARTY_PUBLISHER_LABEL));
        assert!(!tmp.path().join(TRUST_STORE_FILE_NAME).exists());
    }

    #[test]
    fn pinning_a_different_key_under_a_bundled_id_is_rejected() {
        let (key, pem) = test_key_pem(7);
        let (key_id, public_key) = ids_of(&key);
        let (_, other_public) = ids_of(&ed25519_dalek::SigningKey::from_bytes(&[9; 32]));
        let tmp = TempDir::new().unwrap();
        let mut store = TrustStore::load_with_bundled_pem(tmp.path(), &pem).unwrap();

        assert!(matches!(
            store.pin(&key_id, &other_public, "Impostor"),
            Err(TrustStoreError::BundledKeyConflict(_))
        ));
        let entry = store
            .list()
            .into_iter()
            .find(|p| p.key_id == key_id)
            .unwrap();
        assert_eq!(entry.public_key, public_key);
        assert_eq!(entry.source, TrustSource::Bundled);
    }

    #[test]
    fn trust_store_file_cannot_override_or_remove_the_bundled_key() {
        let (key, pem) = test_key_pem(7);
        let (key_id, public_key) = ids_of(&key);
        let (_, other_public) = ids_of(&ed25519_dalek::SigningKey::from_bytes(&[9; 32]));
        let tmp = TempDir::new().unwrap();

        // An attacker rewrites trust-store.json: claims the bundled id with their
        // own key and label, marks it user-pinned, and drops nothing else.
        let forged = serde_json::json!({
            "publishers": [{
                "keyId": key_id,
                "publicKey": other_public,
                "label": "Attacker",
                "source": "user-pinned",
                "addedAt": "2026-01-01T00:00:00Z"
            }]
        });
        std::fs::write(
            tmp.path().join(TRUST_STORE_FILE_NAME),
            serde_json::to_string(&forged).unwrap(),
        )
        .unwrap();

        let store = TrustStore::load_with_bundled_pem(tmp.path(), &pem).unwrap();
        let entry = store
            .list()
            .into_iter()
            .find(|p| p.key_id == key_id)
            .unwrap();
        assert_eq!(entry.public_key, public_key, "the compiled-in key wins");
        assert_eq!(entry.source, TrustSource::Bundled);
        assert_eq!(entry.label, FIRST_PARTY_PUBLISHER_LABEL);

        // An empty (or deleted) trust-store.json still trusts the bundled key.
        std::fs::write(
            tmp.path().join(TRUST_STORE_FILE_NAME),
            r#"{"publishers":[]}"#,
        )
        .unwrap();
        let store = TrustStore::load_with_bundled_pem(tmp.path(), &pem).unwrap();
        assert!(store.is_trusted(&key_id));
        std::fs::remove_file(tmp.path().join(TRUST_STORE_FILE_NAME)).unwrap();
        let store = TrustStore::load_with_bundled_pem(tmp.path(), &pem).unwrap();
        assert!(store.is_trusted(&key_id));
    }

    #[test]
    fn rotation_overlap_seeds_every_distinct_key_once() {
        let (a, pem_a) = test_key_pem(7);
        let (b, pem_b) = test_key_pem(8);
        let pem = format!("{pem_a}{pem_b}{pem_a}");
        let keys = bundled_keys_from_pem(&pem);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].key_id, ids_of(&a).0);
        assert_eq!(keys[1].key_id, ids_of(&b).0);
    }
}
