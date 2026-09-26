//! Persisted file-browser bookmarks (PROD-007, #3558).
//!
//! A bookmark is a directory the user pinned in the file browser, scoped to the
//! connection it belongs to. The scope is an opaque string the frontend derives
//! (`local`, `wsl:<distro>`, `connection:<saved id>`, …) so the backend never
//! has to know how a tab maps to a connection; it only stores, bounds and
//! returns the records. The bounds live in
//! [`crate::files::bookmarks_manager`]; this module is only the on-disk shape.

use serde::{Deserialize, Serialize};

/// One bookmarked directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileBookmark {
    /// Unique identifier for this bookmark.
    pub id: String,
    /// The connection scope the bookmark belongs to (opaque, frontend-derived).
    pub scope: String,
    /// The bookmarked directory, exactly as the file browser navigates to it.
    pub path: String,
    /// Display name — the directory's base name unless the user renamed it.
    pub name: String,
    /// RFC 3339 timestamp of when the bookmark was added.
    #[serde(default)]
    pub created_at: String,
}

/// Top-level schema for the `file-browser-bookmarks.json` file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBookmarkStore {
    /// Schema version, read on load and gated by the migration layer. A
    /// version-less (hand-edited) file is read as v1.
    #[serde(default = "default_version")]
    pub version: String,
    /// Every bookmark, in the order it was added.
    pub bookmarks: Vec<FileBookmark>,
    /// Unknown top-level keys, captured verbatim so an older app preserves
    /// fields a newer version added rather than dropping them on save (PER-010).
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_version() -> String {
    // A version-less file predates versioning, i.e. it is v1.
    "1".to_string()
}

impl Default for FileBookmarkStore {
    fn default() -> Self {
        Self {
            version: <Self as crate::utils::migrate::VersionedStore>::CURRENT_VERSION.to_string(),
            bookmarks: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

impl crate::utils::migrate::VersionedStore for FileBookmarkStore {
    const STORE_NAME: &'static str = "file-browser-bookmarks.json";
    const CURRENT_VERSION: u32 = 1;

    /// Per-entry salvage (PER-004): drop only the individually-corrupt
    /// bookmarks instead of resetting the whole store.
    fn salvage(raw: &str, file_name: &str) -> crate::utils::migrate::Salvage<Self> {
        crate::utils::migrate::salvage_list_store::<Self, FileBookmark>(
            raw,
            file_name,
            "bookmarks",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::migrate::{load_versioned, LoadOutcome, VersionedStore};

    #[test]
    fn default_uses_the_current_version() {
        assert_eq!(
            FileBookmarkStore::default().version,
            <FileBookmarkStore as VersionedStore>::CURRENT_VERSION.to_string()
        );
    }

    #[test]
    fn bookmark_serializes_with_frontend_shape() {
        let b = FileBookmark {
            id: "b1".into(),
            scope: "connection:c1".into(),
            path: "/var/log".into(),
            name: "log".into(),
            created_at: "2026-09-26T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"createdAt\":\"2026-09-26T00:00:00Z\""));
        assert!(json.contains("\"scope\":\"connection:c1\""));
        let parsed: FileBookmark = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, b);
    }

    #[test]
    fn versionless_file_loads_as_v1() {
        let raw = r#"{"bookmarks": [{"id":"b","scope":"local","path":"/","name":"/"}]}"#;
        match load_versioned::<FileBookmarkStore>(raw) {
            LoadOutcome::Loaded { data, .. } => {
                assert_eq!(data.bookmarks.len(), 1);
                assert_eq!(data.bookmarks[0].created_at, "");
            }
            _ => panic!("a version-less file must load as v1"),
        }
    }

    #[test]
    fn newer_version_is_reported_not_parsed() {
        let raw = r#"{"version": "2", "bookmarks": []}"#;
        assert!(matches!(
            load_versioned::<FileBookmarkStore>(raw),
            LoadOutcome::Newer(_)
        ));
    }

    #[test]
    fn unknown_top_level_keys_survive_round_trip() {
        let raw = r#"{"version": "1", "bookmarks": [], "addedLater": [1]}"#;
        let store: FileBookmarkStore = serde_json::from_str(raw).unwrap();
        let out = serde_json::to_value(&store).unwrap();
        assert_eq!(out["addedLater"], serde_json::json!([1]));
    }
}
