//! The host-key trust-store section shape (#3515): validation, the
//! "covered" check and conflict listing for `ssh_known_hosts.json` /
//! `rdp_known_hosts.json` (a flat `host:port` → fingerprints object). See
//! [`super::sections::Shape::TrustMap`] for the merge rules.

use serde_json::Value;

use super::sections::NormalizeError;

/// Schema version of the host-key trust stores' backup section.
///
/// The trust-store files carry no `version` field: their on-disk format (a flat
/// `host → [fingerprint]` object) is deliberately left unchanged, because
/// adding a `version` key inside that object would make every older termiHub
/// read the file as corrupt and start with an empty store — the very downgrade
/// data loss the migration layer exists to prevent (#2745). The format is
/// versioned where it leaves the machine instead: the backup section records
/// schema version 1, and a section with a newer version is refused
/// ([`SectionSpec::normalize_section`]).
pub const TRUST_STORE_SCHEMA_VERSION: u32 = 1;

/// Upper bound on hosts in a restored trust store, so a hostile backup cannot
/// balloon the store.
const MAX_TRUST_HOSTS: usize = 100_000;
/// Upper bound on fingerprints remembered for one host.
const MAX_TRUST_FINGERPRINTS_PER_HOST: usize = 64;
/// Upper bound on the length of a host key or a fingerprint.
const MAX_TRUST_FIELD_LEN: usize = 1024;

/// Validate a trust-store document: an object mapping a non-empty host to a
/// list of non-empty fingerprint strings. Duplicate fingerprints are dropped;
/// hosts with no fingerprints are removed (the stores never write those).
pub(super) fn normalize_trust_map(data: Value) -> Result<Value, NormalizeError> {
    let Value::Object(map) = data else {
        return Err(NormalizeError::Invalid(
            "expected a JSON object".to_string(),
        ));
    };
    if map.len() > MAX_TRUST_HOSTS {
        return Err(NormalizeError::Invalid(format!(
            "more than {MAX_TRUST_HOSTS} hosts"
        )));
    }
    let mut out = serde_json::Map::new();
    for (host, fps) in map {
        if host.trim().is_empty() || host.len() > MAX_TRUST_FIELD_LEN {
            return Err(NormalizeError::Invalid(format!("invalid host \"{host}\"")));
        }
        let Value::Array(fps) = fps else {
            return Err(NormalizeError::Invalid(format!(
                "the keys of \"{host}\" are not a list"
            )));
        };
        if fps.len() > MAX_TRUST_FINGERPRINTS_PER_HOST {
            return Err(NormalizeError::Invalid(format!(
                "too many keys for \"{host}\""
            )));
        }
        let mut clean: Vec<Value> = Vec::new();
        for fp in fps {
            match fp.as_str() {
                Some(s) if !s.trim().is_empty() && s.len() <= MAX_TRUST_FIELD_LEN => {
                    if !clean.iter().any(|c| c.as_str() == Some(s)) {
                        clean.push(Value::String(s.to_string()));
                    }
                }
                _ => {
                    return Err(NormalizeError::Invalid(format!(
                        "invalid key for \"{host}\""
                    )))
                }
            }
        }
        if !clean.is_empty() {
            out.insert(host, Value::Array(clean));
        }
    }
    Ok(Value::Object(out))
}

/// Whether every fingerprint the backup has for a host is already trusted
/// here (the backup adds nothing for it).
pub(super) fn fingerprints_covered(backup: &Value, current: &Value) -> bool {
    let current: Vec<&str> = current
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    backup
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .all(|fp| current.contains(&fp))
        })
        .unwrap_or(true)
}

/// Hosts that are trusted here with keys the backup does not match — the
/// conflicts a trust-store merge keeps as they are (sorted).
pub fn trust_conflicts(backup: &Value, current: &Value) -> Vec<String> {
    let (Some(backup), Some(current)) = (backup.as_object(), current.as_object()) else {
        return Vec::new();
    };
    let mut hosts: Vec<String> = backup
        .iter()
        .filter(|(host, fps)| {
            current
                .get(*host)
                .is_some_and(|existing| !fingerprints_covered(fps, existing))
        })
        .map(|(host, _)| host.clone())
        .collect();
    hosts.sort();
    hosts
}
