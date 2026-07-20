//! Persisted per-host RDP server-certificate trust store (#1767).
//!
//! The SSH `known_hosts` analogue for RDP: it remembers the SHA-256 public-key
//! fingerprints a user has chosen to trust for a given host, so a subsequent
//! connect to a remembered host does not re-prompt, and a *changed* fingerprint
//! for a previously-trusted host is flagged as a possible man-in-the-middle.
//!
//! The store lives on the **host** (not the sidecar) because only the host knows
//! the config directory — including portable mode. The RDP sidecar merely relays
//! the fingerprint; the [`GraphicalSessionManager`](super::graphical_manager)
//! consults this store to decide whether to auto-accept, prompt, or warn.
//!
//! ## On-disk format
//!
//! A single JSON object mapping host → the list of accepted fingerprints:
//!
//! ```json
//! { "server.example:3389": ["sha256:AB:CD:…", "sha256:12:34:…"] }
//! ```
//!
//! Multiple fingerprints per host are allowed (a host may legitimately rotate
//! its key, exactly as `known_hosts` tolerates), so "remember" appends rather
//! than replaces. A presented fingerprint that matches *any* stored entry for
//! the host is trusted; one that matches none while the host has entries is the
//! changed / MITM case.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tracing::warn;

/// The trust-store file name inside the config directory.
const FILE_NAME: &str = "rdp_known_hosts.json";

/// The verdict of consulting the trust store for a presented fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLookup {
    /// The host+fingerprint pair is already trusted: accept without prompting.
    Trusted,
    /// The host has no remembered fingerprint: first contact, prompt the user.
    Unknown,
    /// The host is remembered but with a *different* fingerprint: possible MITM,
    /// warn prominently before proceeding.
    Changed,
}

/// A persisted per-host RDP certificate trust store.
///
/// Cheap to clone-share behind an `Arc`; all mutation goes through an internal
/// mutex and is written through to disk immediately (the store is tiny).
pub struct RdpTrustStore {
    /// Backing file, or `None` for an in-memory store (tests / no config dir).
    path: Option<PathBuf>,
    /// host → accepted fingerprints.
    entries: Mutex<BTreeMap<String, Vec<String>>>,
}

impl RdpTrustStore {
    /// Open (or start) a trust store backed by `FILE_NAME` inside `config_dir`.
    ///
    /// A missing or unreadable file starts empty rather than failing — an absent
    /// trust store simply means "nothing remembered yet".
    pub fn open(config_dir: PathBuf) -> Self {
        let path = config_dir.join(FILE_NAME);
        let entries = load(&path);
        Self {
            path: Some(path),
            entries: Mutex::new(entries),
        }
    }

    /// An in-memory store that never touches disk. Used by tests and as a safe
    /// fallback when no config directory could be resolved.
    pub fn in_memory() -> Self {
        Self {
            path: None,
            entries: Mutex::new(BTreeMap::new()),
        }
    }

    /// Classify a presented `fingerprint` for `host` against what is remembered.
    pub fn lookup(&self, host: &str, fingerprint: &str) -> TrustLookup {
        let entries = self.entries.lock().expect("trust store mutex poisoned");
        match entries.get(host) {
            Some(fps) if fps.iter().any(|f| f == fingerprint) => TrustLookup::Trusted,
            Some(fps) if !fps.is_empty() => TrustLookup::Changed,
            _ => TrustLookup::Unknown,
        }
    }

    /// Remember `fingerprint` as trusted for `host` and persist immediately.
    ///
    /// Idempotent: remembering an already-trusted pair is a no-op. Persistence
    /// failures are logged, not surfaced — the in-memory decision still holds for
    /// the session.
    pub fn remember(&self, host: &str, fingerprint: &str) {
        {
            let mut entries = self.entries.lock().expect("trust store mutex poisoned");
            let fps = entries.entry(host.to_string()).or_default();
            if fps.iter().any(|f| f == fingerprint) {
                return;
            }
            fps.push(fingerprint.to_string());
        }
        self.persist();
    }

    /// Snapshot every remembered host and its trusted fingerprints, for the
    /// trust-management settings UI (#1784). Cloned so callers never hold the
    /// lock; the store is tiny.
    pub fn entries(&self) -> BTreeMap<String, Vec<String>> {
        self.entries
            .lock()
            .expect("trust store mutex poisoned")
            .clone()
    }

    /// Forget a single `fingerprint` for `host`, persisting immediately (#1784).
    ///
    /// When the host's last fingerprint is removed the host entry is dropped
    /// entirely, so a subsequent connect is treated as first contact (prompt)
    /// rather than a changed key. Returns `true` when something was removed.
    pub fn forget_fingerprint(&self, host: &str, fingerprint: &str) -> bool {
        let removed = {
            let mut entries = self.entries.lock().expect("trust store mutex poisoned");
            let Some(fps) = entries.get_mut(host) else {
                return false;
            };
            let before = fps.len();
            fps.retain(|f| f != fingerprint);
            let removed = fps.len() != before;
            if fps.is_empty() {
                entries.remove(host);
            }
            removed
        };
        if removed {
            self.persist();
        }
        removed
    }

    /// Forget every fingerprint remembered for `host`, persisting immediately
    /// (#1784). Returns `true` when the host had remembered entries.
    pub fn forget_host(&self, host: &str) -> bool {
        let removed = {
            let mut entries = self.entries.lock().expect("trust store mutex poisoned");
            entries.remove(host).is_some()
        };
        if removed {
            self.persist();
        }
        removed
    }

    /// Write the current entries to disk (no-op for an in-memory store).
    fn persist(&self) {
        let Some(path) = &self.path else { return };
        let entries = self.entries.lock().expect("trust store mutex poisoned");
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let json = serde_json::to_string_pretty(&*entries)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            std::fs::write(path, json)
        };
        if let Err(e) = write() {
            warn!(path = %path.display(), error = %e, "failed to persist RDP trust store");
        }
    }
}

/// Load the entries from `path`, returning an empty map on any error.
fn load(path: &PathBuf) -> BTreeMap<String, Vec<String>> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    match serde_json::from_slice(&bytes) {
        Ok(map) => map,
        Err(e) => {
            warn!(path = %path.display(), error = %e, "RDP trust store is corrupt; starting empty");
            BTreeMap::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP_A: &str = "sha256:AA:BB:CC";
    const FP_B: &str = "sha256:11:22:33";

    #[test]
    fn unknown_host_prompts() {
        let store = RdpTrustStore::in_memory();
        assert_eq!(store.lookup("host:3389", FP_A), TrustLookup::Unknown);
    }

    #[test]
    fn remembered_fingerprint_is_trusted_silently() {
        let store = RdpTrustStore::in_memory();
        store.remember("host:3389", FP_A);
        assert_eq!(store.lookup("host:3389", FP_A), TrustLookup::Trusted);
        // A different host is still unknown.
        assert_eq!(store.lookup("other:3389", FP_A), TrustLookup::Unknown);
    }

    #[test]
    fn changed_fingerprint_is_flagged_as_mitm() {
        let store = RdpTrustStore::in_memory();
        store.remember("host:3389", FP_A);
        // Same host, different key → the changed/MITM case, not "unknown".
        assert_eq!(store.lookup("host:3389", FP_B), TrustLookup::Changed);
    }

    #[test]
    fn remember_is_idempotent_and_allows_rotation() {
        let store = RdpTrustStore::in_memory();
        store.remember("host:3389", FP_A);
        store.remember("host:3389", FP_A); // idempotent
        store.remember("host:3389", FP_B); // rotation: both now trusted
        assert_eq!(store.lookup("host:3389", FP_A), TrustLookup::Trusted);
        assert_eq!(store.lookup("host:3389", FP_B), TrustLookup::Trusted);
    }

    #[test]
    fn persists_and_reloads_across_instances() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        {
            let store = RdpTrustStore::open(dir.clone());
            store.remember("host:3389", FP_A);
            assert_eq!(store.lookup("host:3389", FP_A), TrustLookup::Trusted);
        }
        // A fresh instance over the same directory sees the remembered trust.
        let reopened = RdpTrustStore::open(dir);
        assert_eq!(reopened.lookup("host:3389", FP_A), TrustLookup::Trusted);
        assert_eq!(reopened.lookup("host:3389", FP_B), TrustLookup::Changed);
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        std::fs::write(dir.join(FILE_NAME), b"not json").unwrap();
        let store = RdpTrustStore::open(dir);
        assert_eq!(store.lookup("host:3389", FP_A), TrustLookup::Unknown);
    }

    #[test]
    fn entries_returns_snapshot_of_all_hosts() {
        let store = RdpTrustStore::in_memory();
        store.remember("a:3389", FP_A);
        store.remember("a:3389", FP_B);
        store.remember("b:3389", FP_A);
        let entries = store.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries.get("a:3389").unwrap(),
            &vec![FP_A.to_string(), FP_B.to_string()]
        );
        assert_eq!(entries.get("b:3389").unwrap(), &vec![FP_A.to_string()]);
    }

    #[test]
    fn forget_fingerprint_removes_one_and_keeps_others() {
        let store = RdpTrustStore::in_memory();
        store.remember("a:3389", FP_A);
        store.remember("a:3389", FP_B);
        assert!(store.forget_fingerprint("a:3389", FP_A));
        // The revoked key is now the changed/MITM case; the sibling still trusts.
        assert_eq!(store.lookup("a:3389", FP_A), TrustLookup::Changed);
        assert_eq!(store.lookup("a:3389", FP_B), TrustLookup::Trusted);
    }

    #[test]
    fn forgetting_last_fingerprint_drops_host_and_reprompts() {
        let store = RdpTrustStore::in_memory();
        store.remember("a:3389", FP_A);
        assert!(store.forget_fingerprint("a:3389", FP_A));
        // Host is gone entirely: the next contact is first contact, not "changed".
        assert_eq!(store.lookup("a:3389", FP_A), TrustLookup::Unknown);
        assert!(store.entries().is_empty());
    }

    #[test]
    fn forget_fingerprint_returns_false_when_absent() {
        let store = RdpTrustStore::in_memory();
        store.remember("a:3389", FP_A);
        assert!(!store.forget_fingerprint("a:3389", FP_B));
        assert!(!store.forget_fingerprint("missing:3389", FP_A));
        // The untouched entry is still trusted.
        assert_eq!(store.lookup("a:3389", FP_A), TrustLookup::Trusted);
    }

    #[test]
    fn forget_host_removes_all_fingerprints() {
        let store = RdpTrustStore::in_memory();
        store.remember("a:3389", FP_A);
        store.remember("a:3389", FP_B);
        assert!(store.forget_host("a:3389"));
        assert_eq!(store.lookup("a:3389", FP_A), TrustLookup::Unknown);
        // Idempotent: forgetting an already-forgotten host removes nothing.
        assert!(!store.forget_host("a:3389"));
    }

    #[test]
    fn revocations_persist_across_instances() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_path_buf();
        {
            let store = RdpTrustStore::open(dir.clone());
            store.remember("a:3389", FP_A);
            store.remember("a:3389", FP_B);
            store.remember("b:3389", FP_A);
            assert!(store.forget_fingerprint("a:3389", FP_A));
            assert!(store.forget_host("b:3389"));
        }
        // A fresh instance over the same directory sees the revocations.
        let reopened = RdpTrustStore::open(dir);
        assert_eq!(reopened.lookup("a:3389", FP_A), TrustLookup::Changed);
        assert_eq!(reopened.lookup("a:3389", FP_B), TrustLookup::Trusted);
        assert_eq!(reopened.lookup("b:3389", FP_A), TrustLookup::Unknown);
    }
}
