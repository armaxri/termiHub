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

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::signature::now_rfc3339;

/// The trust-store file name, alongside the manager's other plugin state files.
pub const TRUST_STORE_FILE_NAME: &str = "trust-store.json";

/// How a trusted key came to be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
}

/// The persisted `trust-store.json` document: only user-pinned keys are written
/// (bundled keys are re-seeded on every load).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TrustStoreDoc {
    #[serde(default)]
    publishers: Vec<TrustedPublisher>,
}

/// The bundled first-party keys seeded into every trust store.
///
/// **Empty in v1.** The mechanism is fully wired — a non-empty list here would
/// make those publishers verify as `Verified` out of the box — but no
/// first-party key is embedded yet: doing so honestly requires a real key
/// ceremony (the private half must never be committed) and signing the bundled
/// example plugins. Tracked as a follow-up; until then, trust is established
/// entirely through TOFU pinning, which is fully functional.
const BUNDLED_PUBLISHERS: &[BundledKey] = &[];

/// A compile-time bundled key entry (kept minimal so the seed list is a plain
/// `const`).
struct BundledKey {
    key_id: &'static str,
    public_key: &'static str,
    label: &'static str,
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
        Self::load_with_bundled(plugins_root, BUNDLED_PUBLISHERS)
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
            publishers.insert(
                key.key_id.to_owned(),
                TrustedPublisher {
                    key_id: key.key_id.to_owned(),
                    public_key: key.public_key.to_owned(),
                    label: key.label.to_owned(),
                    source: TrustSource::Bundled,
                    added_at: now.clone(),
                },
            );
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
            .map(|key| {
                (
                    key.key_id.to_owned(),
                    TrustedPublisher {
                        key_id: key.key_id.to_owned(),
                        public_key: key.public_key.to_owned(),
                        label: key.label.to_owned(),
                        source: TrustSource::Bundled,
                        added_at: now.clone(),
                    },
                )
            })
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
    /// pinning a key id that is already **bundled** is a no-op (it is already
    /// trusted and immutable). Persists the store.
    pub fn pin(
        &mut self,
        key_id: &str,
        public_key: &str,
        label: &str,
    ) -> Result<(), TrustStoreError> {
        if matches!(
            self.publishers.get(key_id).map(|p| p.source),
            Some(TrustSource::Bundled)
        ) {
            return Ok(());
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

    const BUNDLED: &[BundledKey] = &[BundledKey {
        key_id: "sha256:bundledaaaa",
        public_key: "QUJD",
        label: "termiHub Official",
    }];

    fn store_with_bundled(root: &Path) -> TrustStore {
        TrustStore::load_with_bundled(root, BUNDLED).unwrap()
    }

    #[test]
    fn empty_store_trusts_nothing_by_default() {
        let tmp = TempDir::new().unwrap();
        let store = TrustStore::load(tmp.path()).unwrap();
        assert!(!store.is_trusted("sha256:anything"));
        assert!(store.list().is_empty());
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
}
