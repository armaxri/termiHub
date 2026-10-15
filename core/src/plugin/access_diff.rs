//! The access an update changes: what an incoming manifest requests that the
//! installed one did not, and what it no longer requests (#4418).
//!
//! The install dialog shows this on an update or a re-install so the user sees,
//! at the point of confirming, that the new version asks for more. It is
//! computed from the same canonical [`ApprovedAccess`] a native trust
//! acknowledgment binds to (#4294, #4533), so the dialog and the trust binding
//! agree on what changed: a folder is compared by the folder it resolves to on
//! this computer, normalised by [`normalize_declared_path`](super::normalize_declared_path),
//! and shown next to the declared `${home}`/`${config}` form.

use serde::{Deserialize, Serialize};

use super::manifest::{ConnectionPolicyManifest, PluginManifest, PluginPermission};
use super::native_trust::{normalize_declared_path, ApprovedAccess};
use super::path_placeholders::{resolve, PlaceholderBases};

/// One `filesystemPaths` folder in an [`AccessDelta`]: the folder the plugin
/// can reach on this computer and the entry the manifest declared for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "PluginAccessDiffPath"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct AccessDiffPath {
    /// The entry as declared in the manifest (e.g. `${home}/.kube`).
    pub declared: String,
    /// The normalised folder it resolves to on this computer — what the
    /// trust binding compares. Equal to `declared` (up to normalisation) for
    /// an entry without a placeholder; the declared entry verbatim when it
    /// cannot be resolved here.
    pub folder: String,
}

/// The permissions and folders one side of an [`PluginAccessDiff`] lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "PluginAccessDelta"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct AccessDelta {
    /// Permissions, sorted and without duplicates.
    pub permissions: Vec<PluginPermission>,
    /// Folders, sorted by [`folder`](AccessDiffPath::folder).
    pub filesystem_paths: Vec<AccessDiffPath>,
}

impl AccessDelta {
    /// Whether this side lists nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.permissions.is_empty() && self.filesystem_paths.is_empty()
    }
}

/// A change of the declared `connectionPolicy`: both sides, so the dialog can
/// show what changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "PluginConnectionPolicyChange"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPolicyChange {
    /// The installed version's policy; `null` when it declared none.
    pub before: Option<ConnectionPolicyManifest>,
    /// The incoming version's policy; `null` when it declares none.
    pub after: Option<ConnectionPolicyManifest>,
}

/// What an incoming manifest changes in the access the installed one requests
/// (#4418), computed from [`ApprovedAccess`] on both sides.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../src/types/generated/",
        rename = "PluginAccessDiff"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct PluginAccessDiff {
    /// Access the incoming version requests that the installed one did not.
    pub added: AccessDelta,
    /// Access the installed version requested that the incoming one drops.
    pub removed: AccessDelta,
    /// The `connectionPolicy` change, when the policy differs.
    pub connection_policy: Option<ConnectionPolicyChange>,
}

impl PluginAccessDiff {
    /// The diff from `installed` to `incoming`, resolving `${home}`/`${config}`
    /// against this host's folders.
    #[must_use]
    pub fn between(installed: &PluginManifest, incoming: &PluginManifest) -> Self {
        Self::between_with_bases(installed, incoming, &PlaceholderBases::host())
    }

    /// [`between`](Self::between), resolving placeholders against explicit
    /// `bases`.
    #[must_use]
    pub fn between_with_bases(
        installed: &PluginManifest,
        incoming: &PluginManifest,
        bases: &PlaceholderBases,
    ) -> Self {
        let before = ApprovedAccess::from_manifest_with_bases(installed, bases);
        let after = ApprovedAccess::from_manifest_with_bases(incoming, bases);
        let connection_policy =
            (before.connection_policy != after.connection_policy).then(|| ConnectionPolicyChange {
                before: before.connection_policy.clone(),
                after: after.connection_policy.clone(),
            });
        Self {
            added: delta(&after, &before, incoming, bases),
            removed: delta(&before, &after, installed, bases),
            connection_policy,
        }
    }

    /// Whether the incoming version requests anything the installed one did
    /// not — the case the dialog flags as "asks for more access". A changed
    /// `connectionPolicy` that the incoming version still declares counts, as
    /// it does for [`ApprovedAccess::added_since`].
    #[must_use]
    pub fn adds_access(&self) -> bool {
        !self.added.is_empty()
            || self
                .connection_policy
                .as_ref()
                .is_some_and(|c| c.after.is_some())
    }

    /// Whether nothing changed.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.connection_policy.is_none()
    }
}

/// What `side` requests that `other` does not, with each folder's declared
/// form taken from `manifest` (the manifest `side` was built from).
fn delta(
    side: &ApprovedAccess,
    other: &ApprovedAccess,
    manifest: &PluginManifest,
    bases: &PlaceholderBases,
) -> AccessDelta {
    let permissions = side
        .permissions
        .iter()
        .filter(|p| !other.permissions.contains(p))
        .copied()
        .collect();
    let filesystem_paths = side
        .filesystem_paths
        .iter()
        .filter(|f| !other.filesystem_paths.contains(f))
        .map(|folder| AccessDiffPath {
            declared: declared_for(folder, manifest, bases),
            folder: folder.clone(),
        })
        .collect();
    AccessDelta {
        permissions,
        filesystem_paths,
    }
}

/// The first `filesystemPaths` entry of `manifest` that canonicalises to
/// `folder` exactly as [`ApprovedAccess::from_manifest_with_bases`] does.
fn declared_for(folder: &str, manifest: &PluginManifest, bases: &PlaceholderBases) -> String {
    manifest
        .filesystem_paths
        .iter()
        .find(|p| canonical_folder(p, bases) == folder)
        .cloned()
        .unwrap_or_else(|| folder.to_owned())
}

/// The canonical folder of one declared entry, mirroring
/// [`ApprovedAccess::from_manifest_with_bases`].
fn canonical_folder(declared: &str, bases: &PlaceholderBases) -> String {
    match resolve(declared, bases) {
        Ok(resolved) => normalize_declared_path(&resolved.path),
        Err(_) => declared.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::parse_manifest;

    fn bases() -> PlaceholderBases {
        PlaceholderBases::new(Some("/home/alice"), Some("/home/alice/.config"))
    }

    /// A manifest requesting `permissions` (JSON array) with optional
    /// `filesystemPaths` and `connectionPolicy` (JSON values).
    fn manifest(
        version: &str,
        permissions: &str,
        paths: Option<&str>,
        policy: Option<&str>,
    ) -> PluginManifest {
        let mut extra = String::new();
        if let Some(paths) = paths {
            extra.push_str(&format!(r#""filesystemPaths": {paths},"#));
        }
        if let Some(policy) = policy {
            extra.push_str(&format!(r#""connectionPolicy": {policy},"#));
        }
        parse_manifest(&format!(
            r#"{{
                "id": "p", "name": "P", "version": "{version}", "author": "a",
                "description": "d", "license": "MIT", "apiVersion": "1.1",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions}, {extra}
                "extensions": {{ "terminalBackend": {{
                    "connectionType": "p", "displayName": "P", "configSchema": {{}}
                }} }}
            }}"#
        ))
        .expect("test manifest parses")
    }

    fn path(declared: &str, folder: &str) -> AccessDiffPath {
        AccessDiffPath {
            declared: declared.to_owned(),
            folder: folder.to_owned(),
        }
    }

    #[test]
    fn identical_access_is_an_empty_diff() {
        let v1 = manifest(
            "1.0.0",
            r#"["terminal", "filesystem", "network"]"#,
            Some(r#"["/data/a", "${home}/.kube"]"#),
            Some(r#"{"maxConnections": 2}"#),
        );
        // Reordered, duplicated and spelled differently — the same access.
        let v2 = manifest(
            "1.1.0",
            r#"["network", "filesystem", "terminal", "network"]"#,
            Some(r#"["${home}/.kube/", "/data//a/"]"#),
            Some(r#"{"maxConnections": 2}"#),
        );
        let diff = PluginAccessDiff::between_with_bases(&v1, &v2, &bases());
        assert!(diff.is_empty(), "{diff:?}");
        assert!(!diff.adds_access());
        assert_eq!(diff, PluginAccessDiff::default());
        // A re-install of the very same manifest is an empty diff too.
        let same = PluginAccessDiff::between_with_bases(&v1, &v1, &bases());
        assert!(same.is_empty());
    }

    #[test]
    fn added_permissions_folders_and_policy_are_listed() {
        let v1 = manifest("1.0.0", r#"["terminal"]"#, None, None);
        let v2 = manifest(
            "2.0.0",
            r#"["terminal", "network", "filesystem"]"#,
            Some(r#"["/data/b/", "${home}/.kube"]"#),
            Some(r#"{"allowLocalNetwork": true}"#),
        );
        let diff = PluginAccessDiff::between_with_bases(&v1, &v2, &bases());
        assert_eq!(
            diff.added.permissions,
            vec![PluginPermission::Network, PluginPermission::Filesystem]
        );
        assert_eq!(
            diff.added.filesystem_paths,
            vec![
                path("/data/b/", "/data/b"),
                path("${home}/.kube", "/home/alice/.kube"),
            ]
        );
        assert!(diff.removed.is_empty());
        let policy = diff.connection_policy.as_ref().expect("policy changed");
        assert_eq!(policy.before, None);
        assert!(policy.after.as_ref().unwrap().allow_local_network);
        assert!(diff.adds_access());
    }

    #[test]
    fn removed_permissions_folders_and_policy_are_listed() {
        let v1 = manifest(
            "1.0.0",
            r#"["terminal", "network", "filesystem"]"#,
            Some(r#"["/data/a", "${config}/p"]"#),
            Some(r#"{"maxConnections": 4}"#),
        );
        let v2 = manifest(
            "2.0.0",
            r#"["terminal", "filesystem"]"#,
            Some(r#"["/data/a"]"#),
            None,
        );
        let diff = PluginAccessDiff::between_with_bases(&v1, &v2, &bases());
        assert!(diff.added.is_empty());
        assert_eq!(diff.removed.permissions, vec![PluginPermission::Network]);
        assert_eq!(
            diff.removed.filesystem_paths,
            vec![path("${config}/p", "/home/alice/.config/p")]
        );
        let policy = diff.connection_policy.as_ref().expect("policy changed");
        assert_eq!(policy.before.as_ref().unwrap().max_connections, Some(4));
        assert_eq!(policy.after, None);
        // Dropping access alone never reads as "asks for more".
        assert!(!diff.adds_access());
        assert!(!diff.is_empty());
    }

    #[test]
    fn a_changed_policy_still_declared_adds_access() {
        let v1 = manifest("1.0.0", "[]", None, Some(r#"{"maxConnections": 2}"#));
        let v2 = manifest("1.0.1", "[]", None, Some(r#"{"maxConnections": 8}"#));
        let diff = PluginAccessDiff::between_with_bases(&v1, &v2, &bases());
        assert!(diff.added.is_empty() && diff.removed.is_empty());
        assert!(diff.adds_access());
    }

    #[test]
    fn a_placeholder_rewritten_to_its_folder_is_no_change() {
        // Trust binds to the resolved folder (#4533): spelling `${home}/x` as
        // the folder it resolves to is the same access.
        let v1 = manifest("1.0.0", r#"["filesystem"]"#, Some(r#"["${home}/x"]"#), None);
        let v2 = manifest(
            "1.0.1",
            r#"["filesystem"]"#,
            Some(r#"["/home/alice/x"]"#),
            None,
        );
        assert!(PluginAccessDiff::between_with_bases(&v1, &v2, &bases()).is_empty());
    }

    #[test]
    fn added_matches_the_trust_rows_added_since() {
        let v1 = manifest(
            "1.0.0",
            r#"["terminal"]"#,
            Some(r#"["/data/a"]"#),
            Some(r#"{"maxConnections": 2}"#),
        );
        let v2 = manifest(
            "2.0.0",
            r#"["terminal", "ui"]"#,
            Some(r#"["/data/a", "${home}/new"]"#),
            Some(r#"{"maxConnections": 3}"#),
        );
        let diff = PluginAccessDiff::between_with_bases(&v1, &v2, &bases());
        let before = ApprovedAccess::from_manifest_with_bases(&v1, &bases());
        let after = ApprovedAccess::from_manifest_with_bases(&v2, &bases());
        let mut labels: Vec<String> = diff
            .added
            .permissions
            .iter()
            .map(|p| {
                serde_json::to_value(p)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        labels.extend(diff.added.filesystem_paths.iter().map(|p| p.folder.clone()));
        if diff
            .connection_policy
            .as_ref()
            .is_some_and(|c| c.after.is_some())
        {
            labels.push("connection policy".to_owned());
        }
        assert_eq!(labels, after.added_since(Some(&before)));
    }
}
