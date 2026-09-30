//! Format-versioning and downgrade-safety regression tests shared by the SSH
//! and RDP trust stores (#2745). Each test is written once against the
//! [`Suite`] abstraction and instantiated for both stores, so both are held to
//! identical guarantees.

use std::path::{Path, PathBuf};

use crate::connection::recovery::RecoveryWarning;
use crate::session::{rdp_trust_store, ssh_trust_store};

/// A store-neutral trust verdict (each store has its own `TrustLookup`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum L {
    Trusted,
    Unknown,
    Changed,
}

const FP_A: &str = "SHA256:AABBCC";
const FP_B: &str = "SHA256:112233";

/// The operations the suite needs from a trust store.
trait Suite {
    /// The store's on-disk file name.
    const FILE: &'static str;
    fn open(dir: PathBuf) -> Self;
    fn lookup(&self, host: &str, fp: &str) -> L;
    fn remember(&self, host: &str, fp: &str);
    fn forget_host(&self, host: &str) -> bool;
    fn host_count(&self) -> usize;
    fn take_load_warnings(&self) -> Vec<RecoveryWarning>;
    fn is_write_refused(&self) -> bool;
}

/// Implement [`Suite`] for one store by delegating to its inherent methods.
macro_rules! impl_suite {
    ($store:ty, $lookup:ident, $file:expr) => {
        impl Suite for $store {
            const FILE: &'static str = $file;
            fn open(dir: PathBuf) -> Self {
                <$store>::open(dir)
            }
            fn lookup(&self, host: &str, fp: &str) -> L {
                match <$store>::lookup(self, host, fp) {
                    $lookup::Trusted => L::Trusted,
                    $lookup::Unknown => L::Unknown,
                    $lookup::Changed => L::Changed,
                }
            }
            fn remember(&self, host: &str, fp: &str) {
                <$store>::remember(self, host, fp)
            }
            fn forget_host(&self, host: &str) -> bool {
                <$store>::forget_host(self, host)
            }
            fn host_count(&self) -> usize {
                self.entries().len()
            }
            fn take_load_warnings(&self) -> Vec<RecoveryWarning> {
                <$store>::take_load_warnings(self)
            }
            fn is_write_refused(&self) -> bool {
                <$store>::is_write_refused(self)
            }
        }
    };
}

use rdp_trust_store::{RdpTrustStore, TrustLookup as RdpLookup};
use ssh_trust_store::{SshTrustStore, TrustLookup as SshLookup};

impl_suite!(SshTrustStore, SshLookup, "ssh_known_hosts.json");
impl_suite!(RdpTrustStore, RdpLookup, "rdp_known_hosts.json");

/// The format-version sidecar next to the store file (`<file>.version`).
fn sidecar<S: Suite>(dir: &Path) -> PathBuf {
    dir.join(format!("{}.version", S::FILE))
}

/// Every backup of the store file in `dir`, sorted.
fn backups<S: Suite>(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().into_owned();
            n.starts_with(S::FILE) && n.contains(".bak")
        })
        .collect();
    out.sort();
    out
}

/// A legacy file (no sidecar — every build before #2745) still loads.
fn legacy_file_without_version_sidecar_loads<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    std::fs::write(
        dir.join(S::FILE),
        format!(r#"{{"a.example:1":["{FP_A}"]}}"#),
    )
    .unwrap();
    let store = S::open(dir.clone());
    assert_eq!(store.lookup("a.example:1", FP_A), L::Trusted);
    assert_eq!(store.lookup("a.example:1", FP_B), L::Changed);
    assert!(store.take_load_warnings().is_empty());
    // Writing stamps the current format version into the sidecar.
    store.remember("a.example:1", FP_B);
    assert_eq!(
        std::fs::read_to_string(sidecar::<S>(&dir)).unwrap().trim(),
        "1",
        "a write must record the format version"
    );
}

/// Downgrade: a file whose sidecar says a NEWER format is left byte-for-byte
/// intact, and this build refuses to write over it.
fn newer_format_file_is_left_intact_and_never_written<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let newer = r#"{"format":"future","hosts":{"x":{"keys":["k"]}}}"#;
    std::fs::write(dir.join(S::FILE), newer).unwrap();
    std::fs::write(sidecar::<S>(&dir), "2\n").unwrap();

    let store = S::open(dir.clone());
    store.remember("a.example:1", FP_A);
    assert!(store.forget_host("a.example:1"));
    store.remember("a.example:1", FP_B);

    assert_eq!(std::fs::read_to_string(dir.join(S::FILE)).unwrap(), newer);
    assert_eq!(std::fs::read_to_string(sidecar::<S>(&dir)).unwrap(), "2\n");
    assert!(
        backups::<S>(&dir).is_empty(),
        "a newer file is never backed up/reset"
    );
    assert!(store.is_write_refused());
    let warnings = store.take_load_warnings();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].message.contains("newer version"));
}

/// Downgrade must never silently TRUST: even when a newer-format file
/// happens to parse as this build's shape, its entries are not interpreted
/// (a newer format may give the same shape a different meaning).
fn newer_format_file_is_never_trusted_even_if_it_parses<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    std::fs::write(
        dir.join(S::FILE),
        format!(r#"{{"a.example:1":["{FP_A}"]}}"#),
    )
    .unwrap();
    std::fs::write(sidecar::<S>(&dir), "7").unwrap();
    let store = S::open(dir);
    assert_ne!(store.lookup("a.example:1", FP_A), L::Trusted);
}

/// An unreadable version marker is an unknown format: treated like a newer
/// one (not interpreted, never overwritten) rather than guessed at.
fn unreadable_version_sidecar_is_refused<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let body = format!(r#"{{"a.example:1":["{FP_A}"]}}"#);
    std::fs::write(dir.join(S::FILE), &body).unwrap();
    std::fs::write(sidecar::<S>(&dir), "v-next").unwrap();
    let store = S::open(dir.clone());
    assert_ne!(store.lookup("a.example:1", FP_A), L::Trusted);
    store.remember("b.example:1", FP_B);
    assert_eq!(std::fs::read_to_string(dir.join(S::FILE)).unwrap(), body);
    assert!(store.is_write_refused());
}

/// A newer build that writes AFTER this one opened the store is honoured at
/// write time too (the guard re-reads the sidecar, it is not load-only).
fn newer_sidecar_appearing_after_open_blocks_writes<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let store = S::open(dir.clone());
    store.remember("a.example:1", FP_A);
    let newer = r#"{"written":"by a newer build"}"#;
    std::fs::write(dir.join(S::FILE), newer).unwrap();
    std::fs::write(sidecar::<S>(&dir), "3").unwrap();

    store.remember("b.example:1", FP_B);
    assert_eq!(std::fs::read_to_string(dir.join(S::FILE)).unwrap(), newer);
    assert!(store.is_write_refused());
}

/// A wholly unparseable file is backed up (original bytes preserved) before
/// anything can overwrite it, and the store reports it.
fn unparseable_file_is_backed_up_before_it_can_be_overwritten<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let garbage = b"{\"a.example:1\": [\"trunc";
    std::fs::write(dir.join(S::FILE), garbage).unwrap();
    let store = S::open(dir.clone());
    store.remember("b.example:1", FP_B);

    let baks = backups::<S>(&dir);
    assert_eq!(baks.len(), 1, "exactly one backup, got {baks:?}");
    assert_eq!(std::fs::read(&baks[0]).unwrap(), garbage);
    let warnings = store.take_load_warnings();
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].message.contains("backed up"));
    // The store keeps working after recovery.
    assert_eq!(store.lookup("b.example:1", FP_B), L::Trusted);
}

/// A readable-but-partly-invalid file is salvaged per entry: every valid
/// host/fingerprint survives, only the corrupt parts are dropped, and the
/// original is backed up.
fn partly_corrupt_file_is_salvaged_per_entry<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let raw = format!(
        r#"{{"a.example:1":["{FP_A}",42,""],"b.example:1":"not-a-list","c.example:1":["{FP_B}"],"":["{FP_A}"]}}"#
    );
    std::fs::write(dir.join(S::FILE), &raw).unwrap();
    let store = S::open(dir.clone());

    // Valid entries survive with their meaning intact.
    assert_eq!(store.lookup("a.example:1", FP_A), L::Trusted);
    assert_eq!(store.lookup("a.example:1", FP_B), L::Changed);
    assert_eq!(store.lookup("c.example:1", FP_B), L::Trusted);
    // The corrupt host is dropped — never trusted.
    assert_eq!(store.lookup("b.example:1", FP_A), L::Unknown);
    assert_eq!(store.host_count(), 2);

    let baks = backups::<S>(&dir);
    assert_eq!(baks.len(), 1);
    assert_eq!(std::fs::read_to_string(&baks[0]).unwrap(), raw);
    let warnings = store.take_load_warnings();
    assert!(!warnings.is_empty());
    assert!(warnings.iter().all(|w| w.file_name == S::FILE));

    // The salvage is durable: a fresh instance sees the same trust.
    let reopened = S::open(dir);
    assert_eq!(reopened.lookup("a.example:1", FP_A), L::Trusted);
    assert_eq!(reopened.lookup("c.example:1", FP_B), L::Trusted);
    assert!(reopened.take_load_warnings().is_empty());
}

/// A second corruption never clobbers the backup of the first.
fn repeated_corruption_keeps_every_backup<S: Suite>() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    std::fs::write(dir.join(S::FILE), b"first garbage").unwrap();
    drop(S::open(dir.clone()));
    std::fs::write(dir.join(S::FILE), b"second garbage").unwrap();
    drop(S::open(dir.clone()));

    let contents: Vec<Vec<u8>> = backups::<S>(&dir)
        .iter()
        .map(|p| std::fs::read(p).unwrap())
        .collect();
    assert_eq!(contents.len(), 2, "both corrupt originals must be kept");
    assert!(contents.contains(&b"first garbage".to_vec()));
    assert!(contents.contains(&b"second garbage".to_vec()));
}

/// Instantiate every suite test for both stores.
macro_rules! for_both_stores {
    ($($name:ident),* $(,)?) => {
        mod ssh {
            use super::*;
            $(#[test] fn $name() { super::$name::<SshTrustStore>(); })*
        }
        mod rdp {
            use super::*;
            $(#[test] fn $name() { super::$name::<RdpTrustStore>(); })*
        }
    };
}

for_both_stores!(
    legacy_file_without_version_sidecar_loads,
    newer_format_file_is_left_intact_and_never_written,
    newer_format_file_is_never_trusted_even_if_it_parses,
    unreadable_version_sidecar_is_refused,
    newer_sidecar_appearing_after_open_blocks_writes,
    unparseable_file_is_backed_up_before_it_can_be_overwritten,
    partly_corrupt_file_is_salvaged_per_entry,
    repeated_corruption_keeps_every_backup,
);
