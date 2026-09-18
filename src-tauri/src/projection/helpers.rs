//! Shared intent-payload extraction helpers (TAURI-010).
//!
//! Every projection domain (`src-tauri/src/*_projection/projection.rs`) parses
//! the same primitive fields out of an [`Intent`]'s JSON `payload` — a required
//! string, an optional string, a required array index, a required bool, an
//! optional typed slice. Before this module each domain re-implemented these
//! byte-for-byte, differing only in whether they went through a local
//! `bad_payload` constructor or inlined the `("bad_payload", …)` tuple — the
//! *behaviour* was identical. They now live here once, `pub(crate)`, so a domain
//! `use`s the canonical copy instead of carrying its own.
//!
//! All rejections use the `"bad_payload"` error code with the exact same message
//! text the domains produced before, so the mutation path is unchanged.
//!
//! Domain-specific extractors (typed enums, whole-slice `*.replace` snapshots,
//! `store_of` — whose return type and message differ per domain) intentionally
//! stay local to their domain module; only the genuinely-identical primitives
//! are shared here.

use serde_json::Value;

use crate::projection::Intent;

/// Build a `bad_payload` rejection tuple `(code, message)` from a message.
///
/// The canonical constructor for the rejection every extractor below returns:
/// the error code is always `"bad_payload"` and advances nothing.
pub(crate) fn bad_payload(message: &str) -> (String, String) {
    ("bad_payload".to_string(), message.to_string())
}

/// Extract a required string field from an intent payload.
///
/// Rejects with `bad_payload("missing '<key>'")` when the field is absent or not
/// a JSON string.
pub(crate) fn required_str(intent: &Intent, key: &str) -> Result<String, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))
}

/// Extract an optional string field; absent or non-string → `None`.
pub(crate) fn optional_str(intent: &Intent, key: &str) -> Option<String> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Extract a required array-index (`usize`) field from an intent payload.
///
/// Rejects with `bad_payload("missing '<key>'")` when the field is absent or not
/// a non-negative JSON integer.
pub(crate) fn required_usize(intent: &Intent, key: &str) -> Result<usize, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))
}

/// Extract a required boolean field from an intent payload.
///
/// Rejects with `bad_payload("missing '<key>'")` when the field is absent or not
/// a JSON boolean.
pub(crate) fn required_bool(intent: &Intent, key: &str) -> Result<bool, (String, String)> {
    intent
        .payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad_payload(&format!("missing '{key}'")))
}

/// Parse an optional typed field, treating an absent or `null` value as the
/// type's default (an empty list/map). Lets a mirror that clears a whole
/// sub-slice be expressed by omitting the field; a present-but-malformed field
/// is a `bad_payload` rejection that advances nothing.
pub(crate) fn optional_typed<T: serde::de::DeserializeOwned + Default>(
    intent: &Intent,
    key: &str,
) -> Result<T, (String, String)> {
    match intent.payload.get(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|e| bad_payload(&format!("invalid {key}: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::Intent;
    use serde_json::json;

    fn intent(payload: Value) -> Intent {
        Intent {
            intent_id: "01J-test".to_string(),
            kind: "test.op".to_string(),
            payload,
            client_id: "client-1".to_string(),
        }
    }

    #[test]
    fn required_str_returns_value_or_rejects() {
        let i = intent(json!({ "name": "abc" }));
        assert_eq!(required_str(&i, "name").unwrap(), "abc");

        let (code, msg) = required_str(&i, "missing").unwrap_err();
        assert_eq!(code, "bad_payload");
        assert_eq!(msg, "missing 'missing'");

        // Wrong JSON type is treated as absent.
        let wrong = intent(json!({ "name": 7 }));
        assert!(required_str(&wrong, "name").is_err());
    }

    #[test]
    fn optional_str_absent_is_none() {
        let i = intent(json!({ "name": "abc" }));
        assert_eq!(optional_str(&i, "name"), Some("abc".to_string()));
        assert_eq!(optional_str(&i, "missing"), None);
        // Non-string is None, not an error.
        let wrong = intent(json!({ "name": 7 }));
        assert_eq!(optional_str(&wrong, "name"), None);
    }

    #[test]
    fn required_usize_returns_value_or_rejects() {
        let i = intent(json!({ "index": 3 }));
        assert_eq!(required_usize(&i, "index").unwrap(), 3);
        assert!(required_usize(&i, "missing").is_err());
        // Negative / non-integer rejected.
        let neg = intent(json!({ "index": -1 }));
        assert!(required_usize(&neg, "index").is_err());
    }

    #[test]
    fn required_bool_returns_value_or_rejects() {
        let i = intent(json!({ "flag": true }));
        assert!(required_bool(&i, "flag").unwrap());
        assert!(required_bool(&i, "missing").is_err());
        let wrong = intent(json!({ "flag": "true" }));
        assert!(required_bool(&wrong, "flag").is_err());
    }

    #[test]
    fn optional_typed_absent_or_null_is_default() {
        let absent = intent(json!({}));
        let v: Vec<String> = optional_typed(&absent, "items").unwrap();
        assert!(v.is_empty());

        let null = intent(json!({ "items": null }));
        let v: Vec<String> = optional_typed(&null, "items").unwrap();
        assert!(v.is_empty());

        let present = intent(json!({ "items": ["a", "b"] }));
        let v: Vec<String> = optional_typed(&present, "items").unwrap();
        assert_eq!(v, vec!["a".to_string(), "b".to_string()]);

        // Present-but-malformed rejects.
        let bad = intent(json!({ "items": 7 }));
        assert!(optional_typed::<Vec<String>>(&bad, "items").is_err());
    }
}
