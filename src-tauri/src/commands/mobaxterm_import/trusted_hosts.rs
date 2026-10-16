//! Classify MobaXterm host keys against termiHub's trust and import the
//! user-approved ones (#4852).
//!
//! A converted key is **new** (nothing trusted for its `host:port`),
//! **trusted** (already recorded — by termiHub's store or the user's
//! `~/.ssh/known_hosts`), a **conflict** (a *different* key is recorded for the
//! host — the possible-MITM case, never imported), or **invalid** (failed the
//! strict conversion in [`hostkeys`](super::hostkeys)). Only new keys the user
//! opted in to are written, through [`SshTrustStore::remember_if_unknown`], so
//! an existing entry is never replaced or extended with a different key.

use std::collections::{HashMap, HashSet};

use russh::keys::ssh_key::PublicKey;
use serde::{Deserialize, Serialize};
use termihub_core::backends::ssh::host_key::{check_system_known_hosts, KnownHostsStatus};

use super::hostkeys::{convert, parse_host_keys, parse_target, ConvertedHostKey};
use crate::session::ssh_trust_store::{SshTrustStore, TrustLookup};

/// Skip reason for a key whose host already trusts a different key.
const CONFLICT_STORE: &str =
    "termiHub already trusts a different key for this host; it is not replaced.";
/// Skip reason for a key that contradicts the user's `~/.ssh/known_hosts`.
const CONFLICT_SYSTEM: &str =
    "Your ~/.ssh/known_hosts has a different key for this host; it is not replaced.";

/// One `[SSH_Hostkeys]` entry in the import preview.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermHostKey {
    /// The entry name as written (`<keytype>@<port>:<host>`); stable selection
    /// key within one file.
    pub id: String,
    /// The host the key was accepted for; empty when the entry name is invalid.
    pub host: String,
    /// The port; absent when the entry name is invalid.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub port: Option<u16>,
    /// SSH algorithm (`ssh-ed25519`, …); absent for an invalid key.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub key_type: Option<String>,
    /// SHA-256 fingerprint (`SHA256:…`); absent for an invalid key.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub fingerprint: Option<String>,
    /// The equivalent OpenSSH `known_hosts` line; absent for an invalid key.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub known_hosts_line: Option<String>,
    /// `"new"`, `"trusted"`, `"conflict"` or `"invalid"`.
    pub status: String,
    /// Why a conflicting or invalid key is not imported.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reason: Option<String>,
}

/// A host key the user approved in the preview: imported only if the file
/// still holds this entry with this exact fingerprint.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct HostKeySelection {
    /// [`MobaxtermHostKey::id`].
    pub id: String,
    /// [`MobaxtermHostKey::fingerprint`] as shown in the preview.
    pub fingerprint: String,
}

/// Outcome of [`import_host_keys`].
#[derive(Debug, Clone, Default, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct HostKeyImportResult {
    /// Keys newly trusted.
    pub imported: u32,
    /// Selected keys that were trusted already.
    pub already_trusted: u32,
    /// Selected keys that were not imported, as `"<id>: <reason>"`.
    pub skipped: Vec<String>,
}

/// termiHub's trust verdict for one converted key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyTrust {
    /// Nothing is trusted for the host yet.
    New,
    /// This exact key is already trusted.
    Trusted,
    /// termiHub's store trusts a different key for the host.
    ConflictStore,
    /// The user's `~/.ssh/known_hosts` records a different key for the host.
    ConflictSystem,
}

impl HostKeyTrust {
    /// The user-facing reason a conflicting key is not imported.
    fn conflict_reason(&self) -> Option<&'static str> {
        match self {
            Self::ConflictStore => Some(CONFLICT_STORE),
            Self::ConflictSystem => Some(CONFLICT_SYSTEM),
            Self::New | Self::Trusted => None,
        }
    }
}

/// Classifies a converted key against existing trust.
pub trait TrustCheck {
    /// The verdict for `key`.
    fn classify(&self, key: &ConvertedHostKey) -> HostKeyTrust;
}

/// Treats every key as new (tests, and previews built without a store).
#[cfg(test)]
pub struct NothingTrusted;

#[cfg(test)]
impl TrustCheck for NothingTrusted {
    fn classify(&self, _key: &ConvertedHostKey) -> HostKeyTrust {
        HostKeyTrust::New
    }
}

/// Signature of the `~/.ssh/known_hosts` check, injectable for tests.
pub type SystemKnownHosts = fn(&str, u16, &PublicKey) -> KnownHostsStatus;

/// Classifies against the user's `~/.ssh/known_hosts` first (exactly as the
/// connect-time verifier does) and then termiHub's own trust store.
pub struct StoreTrust<'a> {
    store: &'a SshTrustStore,
    system: SystemKnownHosts,
}

impl<'a> StoreTrust<'a> {
    /// Classify against `store` and the real `~/.ssh/known_hosts`.
    pub fn new(store: &'a SshTrustStore) -> Self {
        Self::with_system(store, check_system_known_hosts)
    }

    /// Classify against `store` and an injected `known_hosts` check.
    pub fn with_system(store: &'a SshTrustStore, system: SystemKnownHosts) -> Self {
        Self { store, system }
    }
}

impl TrustCheck for StoreTrust<'_> {
    fn classify(&self, key: &ConvertedHostKey) -> HostKeyTrust {
        match (self.system)(&key.host, key.port, &key.public_key) {
            KnownHostsStatus::Match => return HostKeyTrust::Trusted,
            KnownHostsStatus::Changed => return HostKeyTrust::ConflictSystem,
            KnownHostsStatus::Unknown => {}
        }
        match self.store.lookup(&host_port(key), &key.fingerprint) {
            TrustLookup::Trusted => HostKeyTrust::Trusted,
            TrustLookup::Changed => HostKeyTrust::ConflictStore,
            TrustLookup::Unknown => HostKeyTrust::New,
        }
    }
}

/// The trust-store key for a converted host key (same as the connect path's
/// `HostKeyInfo::host_port`).
fn host_port(key: &ConvertedHostKey) -> String {
    format!("{}:{}", key.host, key.port)
}

/// Build the preview entries for every `[SSH_Hostkeys]` line of `text`.
pub fn host_key_entries(text: &str, trust: &dyn TrustCheck) -> Vec<MobaxtermHostKey> {
    parse_host_keys(text)
        .iter()
        .map(|raw| match convert(raw) {
            Ok(key) => {
                let verdict = trust.classify(&key);
                let status = match verdict {
                    HostKeyTrust::New => "new",
                    HostKeyTrust::Trusted => "trusted",
                    HostKeyTrust::ConflictStore | HostKeyTrust::ConflictSystem => "conflict",
                };
                let reason = verdict.conflict_reason().map(str::to_string);
                MobaxtermHostKey {
                    id: raw.id.clone(),
                    host: key.host,
                    port: Some(key.port),
                    key_type: Some(key.key_type),
                    fingerprint: Some(key.fingerprint),
                    known_hosts_line: Some(key.known_hosts_line),
                    status: status.to_string(),
                    reason,
                }
            }
            Err(reason) => {
                let target = parse_target(&raw.id).ok();
                MobaxtermHostKey {
                    id: raw.id.clone(),
                    host: target.as_ref().map(|t| t.host.clone()).unwrap_or_default(),
                    port: target.map(|t| t.port),
                    key_type: None,
                    fingerprint: None,
                    known_hosts_line: None,
                    status: "invalid".to_string(),
                    reason: Some(reason),
                }
            }
        })
        .collect()
}

/// Trust the `selections` found in `text`, re-validating and re-classifying
/// each one now. A key is written only if it is valid, still has the selected
/// fingerprint, and its host has nothing trusted — or only keys added by this
/// same import (MobaXterm may hold several key types for one host).
pub fn import_host_keys(
    text: &str,
    selections: &[HostKeySelection],
    store: &SshTrustStore,
    trust: &dyn TrustCheck,
) -> HostKeyImportResult {
    let raw_by_id: HashMap<String, _> = parse_host_keys(text)
        .into_iter()
        .map(|raw| (raw.id.clone(), raw))
        .collect();
    let mut result = HostKeyImportResult::default();
    let mut added: HashMap<String, HashSet<String>> = HashMap::new();
    let mut seen: HashSet<&str> = HashSet::new();

    for sel in selections {
        if !seen.insert(sel.id.as_str()) {
            continue;
        }
        let mut skip = |why: &str| result.skipped.push(format!("{}: {why}", sel.id));
        let Some(raw) = raw_by_id.get(&sel.id) else {
            skip("the entry is no longer in the file.");
            continue;
        };
        let key = match convert(raw) {
            Ok(key) => key,
            Err(reason) => {
                skip(&reason);
                continue;
            }
        };
        if key.fingerprint != sel.fingerprint {
            skip("the key changed since the preview.");
            continue;
        }
        let hp = host_port(&key);
        match trust.classify(&key) {
            HostKeyTrust::Trusted => {
                result.already_trusted += 1;
                continue;
            }
            // A store conflict made only by keys this import just added (several
            // key types for one host) is not a conflict; anything else is.
            HostKeyTrust::ConflictStore if only_added_this_import(store, &hp, &added) => {}
            HostKeyTrust::ConflictStore => {
                skip(CONFLICT_STORE);
                continue;
            }
            HostKeyTrust::ConflictSystem => {
                skip(CONFLICT_SYSTEM);
                continue;
            }
            HostKeyTrust::New => {}
        }
        let verdict = if added.contains_key(&hp) {
            store.remember(&hp, &key.fingerprint);
            TrustLookup::Unknown
        } else {
            store.remember_if_unknown(&hp, &key.fingerprint)
        };
        match verdict {
            TrustLookup::Unknown => {
                result.imported += 1;
                added.entry(hp).or_default().insert(key.fingerprint);
            }
            TrustLookup::Trusted => result.already_trusted += 1,
            TrustLookup::Changed => skip(CONFLICT_STORE),
        }
    }
    result
}

/// Whether every fingerprint trusted for `hp` was added by this import.
fn only_added_this_import(
    store: &SshTrustStore,
    hp: &str,
    added: &HashMap<String, HashSet<String>>,
) -> bool {
    let Some(ours) = added.get(hp) else {
        return false;
    };
    store
        .fingerprints_for(hp)
        .iter()
        .all(|fp| ours.contains(fp))
}
