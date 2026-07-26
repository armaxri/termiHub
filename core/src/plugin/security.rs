//! Plugin **security hardening**: permission enforcement, filesystem
//! path-scoping, untrusted-source assessment, and the error-recovery state
//! machine (concept impl §13, "Seventh PR — Security and polish").
//!
//! This module is the pure, host-agnostic core of the security layer; the
//! [`super::host::PluginHost`] wires it into the load/execute path. Nothing here
//! performs I/O, so it is exhaustively unit-testable.
//!
//! # What is enforceable today
//!
//! A native plugin backend runs as a dynamic library **in the host process**, so
//! the host cannot intercept a plugin's own syscalls. What it *can* do — and what
//! this module implements — is:
//!
//! * **Permission consistency at load** — a plugin whose declared extensions need
//!   a permission it did not request is refused ([`PermissionSet::check_consistency`]),
//!   so the mismatch is caught before the library is registered rather than
//!   surfacing as a mysterious runtime failure.
//! * **A path-scope guard** ([`FilesystemScope::check`]) — the primitive any
//!   host-mediated filesystem access resolves a plugin-supplied path through. It
//!   requires the `filesystem` permission and rejects paths outside the plugin's
//!   declared roots (including `..` traversal).
//! * **A permission query** ([`PermissionSet::require`]) — the gate a host-mediated
//!   network/settings/etc. capability checks before acting for a plugin.
//! * **Untrusted-source assessment** ([`assess_trust`]) — every package is
//!   unsigned today, so this always reports "untrusted"; install requires explicit
//!   acceptance.
//! * **An error-recovery counter** ([`RestartTracker`]) — bounded auto-restart of
//!   a crashing plugin, then auto-disable.
//!
//! Cryptographic signature *verification* is **out of scope**: termiHub has no
//! signing substrate (no keys, format, or verification chain). [`TrustLevel`]
//! documents this as future work rather than claiming plugins are verified.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use super::manifest::{PluginExtensions, PluginManifest, PluginPermission};

/// A plugin may auto-restart at most this many times after a crash before it is
/// auto-disabled (concept "Error recovery": "up to 3 times, then auto-disabled").
pub const MAX_RESTART_ATTEMPTS: u32 = 3;

/// A permission or path-scope enforcement failure.
///
/// Every variant represents *graceful degradation*, not a host crash: the plugin
/// is refused the operation (and typically marked errored/disabled), while the
/// host continues normally.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PermissionError {
    /// The plugin did not request the permission the operation requires.
    #[error("plugin does not hold the `{0:?}` permission")]
    Denied(PluginPermission),

    /// A filesystem path lies outside every root the plugin declared.
    #[error("path `{path}` is outside the plugin's declared filesystem scope")]
    PathOutsideScope {
        /// The offending path (as requested, before normalization).
        path: PathBuf,
    },

    /// The plugin requested the `filesystem` permission but declared no paths to
    /// scope it to — access is confined to declared paths, so a plugin with none
    /// can access nothing and the declaration is a mistake worth surfacing.
    #[error("plugin requests the `filesystem` permission but declares no paths")]
    FilesystemWithoutPaths,

    /// The plugin declared filesystem paths but did not request the `filesystem`
    /// permission, so those paths would never be honoured.
    #[error("plugin declares filesystem paths but did not request the `filesystem` permission")]
    PathsWithoutFilesystem,

    /// The plugin provides a terminal backend but did not request the `terminal`
    /// permission it needs to create sessions.
    #[error("plugin provides a terminal backend but did not request the `terminal` permission")]
    TerminalWithoutPermission,
}

/// The set of permissions a plugin holds, plus its filesystem scope.
///
/// Built once from a validated [`PluginManifest`] and consulted at every gated
/// call site. Cloneable so a loaded session can carry its own copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionSet {
    granted: BTreeSet<PluginPermission>,
    filesystem: FilesystemScope,
}

impl PermissionSet {
    /// Derive the permission set from a plugin's manifest.
    #[must_use]
    pub fn from_manifest(manifest: &PluginManifest) -> Self {
        Self::from_parts(
            manifest.permissions.iter().copied(),
            &manifest.filesystem_paths,
        )
    }

    /// Build a permission set from explicit granted permissions and declared
    /// filesystem paths — the manifest-free constructor used by host wiring and
    /// tests. The filesystem scope is granted iff
    /// [`Filesystem`](PluginPermission::Filesystem) is among `permissions`.
    #[must_use]
    pub fn from_parts(
        permissions: impl IntoIterator<Item = PluginPermission>,
        filesystem_paths: &[String],
    ) -> Self {
        let granted: BTreeSet<PluginPermission> = permissions.into_iter().collect();
        let filesystem = FilesystemScope::new(
            granted.contains(&PluginPermission::Filesystem),
            filesystem_paths,
        );
        Self {
            granted,
            filesystem,
        }
    }

    /// Whether the plugin holds `permission`.
    #[must_use]
    pub fn grants(&self, permission: PluginPermission) -> bool {
        self.granted.contains(&permission)
    }

    /// Require that the plugin holds `permission`, or fail with
    /// [`PermissionError::Denied`]. This is the gate a host-mediated capability
    /// (network, settings, …) checks before acting on the plugin's behalf.
    pub fn require(&self, permission: PluginPermission) -> Result<(), PermissionError> {
        if self.grants(permission) {
            Ok(())
        } else {
            Err(PermissionError::Denied(permission))
        }
    }

    /// The plugin's filesystem scope (the roots access is confined to).
    #[must_use]
    pub fn filesystem(&self) -> &FilesystemScope {
        &self.filesystem
    }

    /// Resolve and authorize a plugin-supplied filesystem path against the
    /// plugin's declared scope. Convenience for `self.filesystem().check(path)`.
    pub fn check_path(&self, requested: &Path) -> Result<PathBuf, PermissionError> {
        self.filesystem.check(requested)
    }

    /// Validate that the plugin's declared permissions are consistent with the
    /// extensions it provides, before it is loaded.
    ///
    /// A terminal backend needs the `terminal` permission; the `filesystem`
    /// permission needs at least one declared path (and declared paths need the
    /// permission). Catching these at load turns a would-be silent runtime denial
    /// into an actionable [`PluginState::Error`](super::PluginState).
    pub fn check_consistency(&self, extensions: &PluginExtensions) -> Result<(), PermissionError> {
        if extensions.terminal_backend.is_some() && !self.grants(PluginPermission::Terminal) {
            return Err(PermissionError::TerminalWithoutPermission);
        }
        let has_fs_perm = self.grants(PluginPermission::Filesystem);
        let has_paths = !self.filesystem.roots.is_empty();
        if has_fs_perm && !has_paths {
            return Err(PermissionError::FilesystemWithoutPaths);
        }
        if has_paths && !has_fs_perm {
            return Err(PermissionError::PathsWithoutFilesystem);
        }
        Ok(())
    }
}

/// The filesystem paths a plugin is confined to (concept §13: "Plugins
/// requesting `filesystem` permission must declare which paths they need. The
/// Plugin Manager enforces path restrictions.").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilesystemScope {
    /// Whether the plugin holds the `filesystem` permission at all.
    granted: bool,
    /// Normalized, allowed root paths. Access is confined to these subtrees.
    roots: Vec<PathBuf>,
}

impl FilesystemScope {
    /// Build a scope from the `filesystem` permission flag and declared paths.
    /// Paths are lexically normalized so scope checks do not depend on the
    /// filesystem's current state.
    fn new(granted: bool, declared: &[String]) -> Self {
        let roots = declared
            .iter()
            .map(|p| normalize_lexical(Path::new(p)))
            .collect();
        Self { granted, roots }
    }

    /// Whether the plugin holds the `filesystem` permission.
    #[must_use]
    pub fn is_granted(&self) -> bool {
        self.granted
    }

    /// The normalized roots this scope permits.
    #[must_use]
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Authorize access to `requested`, returning the normalized path on success.
    ///
    /// Fails with [`PermissionError::Denied`] if the plugin lacks the
    /// `filesystem` permission, or [`PermissionError::PathOutsideScope`] if the
    /// (lexically normalized) path is not contained in any declared root. `..`
    /// components are collapsed before the containment check, so traversal that
    /// escapes a root is rejected.
    pub fn check(&self, requested: &Path) -> Result<PathBuf, PermissionError> {
        if !self.granted {
            return Err(PermissionError::Denied(PluginPermission::Filesystem));
        }
        let normalized = normalize_lexical(requested);
        for root in &self.roots {
            if normalized == *root || normalized.starts_with(root) {
                return Ok(normalized);
            }
        }
        Err(PermissionError::PathOutsideScope {
            path: requested.to_path_buf(),
        })
    }
}

/// Lexically normalize a path — collapse `.` and `..` and redundant separators
/// **without** touching the filesystem (no symlink resolution).
///
/// `..` pops the preceding normal component; at the root (or the start of a
/// relative path) it is dropped rather than escaping upward, so the result can
/// never rise above its own anchor. This is what makes it sound to compare the
/// result against a scope root with [`Path::starts_with`].
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                // At a root or an empty relative path, `..` cannot escape upward.
                Some(Component::RootDir) | Some(Component::Prefix(_)) | None => {}
                // Preserve a leading run of `..` in a relative path.
                Some(Component::ParentDir) => out.push(Component::ParentDir),
                Some(Component::CurDir) => unreachable!("CurDir is never pushed"),
            },
            other => out.push(other),
        }
    }
    out.iter().map(|c| c.as_os_str()).collect()
}

/// How much a plugin package is trusted at install time.
///
/// Only one variant exists today: termiHub has **no** plugin-signing substrate,
/// so every package is [`Untrusted`](TrustLevel::Untrusted). A future
/// `Signed`/`Verified` variant would carry a cryptographically-checked identity;
/// this enum names the axis so callers can branch on it without pretending
/// verification happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustLevel {
    /// The package's origin cannot be verified — no signature was checked (and no
    /// signing infrastructure exists). The user must accept the risk to install.
    Untrusted,
}

/// The outcome of assessing a package's trust at install time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustAssessment {
    /// The assessed trust level (always [`TrustLevel::Untrusted`] today).
    pub level: TrustLevel,
    /// A user-facing warning to surface before extraction.
    pub warning: String,
}

impl TrustAssessment {
    /// Whether installing this package requires the user to accept an
    /// untrusted-source risk.
    #[must_use]
    pub fn requires_acceptance(&self) -> bool {
        matches!(self.level, TrustLevel::Untrusted)
    }
}

/// Assess how much a `.termihub-plugin` package can be trusted.
///
/// Always reports [`TrustLevel::Untrusted`]: no signature is (or can currently
/// be) verified. The returned warning is what the install gate shows the user
/// before extraction. Deliberately does not open the package — trust is a
/// property of provenance, and no provenance is verifiable today.
#[must_use]
pub fn assess_trust(_package_path: &Path) -> TrustAssessment {
    TrustAssessment {
        level: TrustLevel::Untrusted,
        warning: "This plugin comes from an unverified source. termiHub cannot check who \
                  built it, and a native plugin runs with the same privileges as the app. \
                  Only install plugins you trust."
            .to_owned(),
    }
}

/// The lifecycle state in the plugin error-recovery machine (concept "Error
/// recovery state machine").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryState {
    /// Running normally.
    Healthy,
    /// A crash occurred and `attempts` auto-restarts have been made so far.
    Recovering {
        /// Number of restarts attempted since the last healthy state.
        attempts: u32,
    },
    /// The restart budget was exhausted; the plugin is auto-disabled and will not
    /// be retried until the user re-enables it.
    Disabled,
}

/// What the host should do in response to a recorded plugin failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryAction {
    /// Attempt to reload the plugin (restart budget not yet exhausted).
    Restart,
    /// Give up and auto-disable the plugin (budget exhausted).
    Disable,
}

/// Bounded restart-then-disable counter for one plugin.
///
/// Implements the concept's recovery policy: a crashing plugin is auto-restarted
/// up to [`MAX_RESTART_ATTEMPTS`] times; the failure that would exceed the budget
/// auto-disables it instead. A successful run resets the counter.
#[derive(Debug, Clone)]
pub struct RestartTracker {
    state: RecoveryState,
    max_attempts: u32,
}

impl Default for RestartTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl RestartTracker {
    /// A fresh tracker in the [`Healthy`](RecoveryState::Healthy) state with the
    /// default budget of [`MAX_RESTART_ATTEMPTS`].
    #[must_use]
    pub fn new() -> Self {
        Self::with_max(MAX_RESTART_ATTEMPTS)
    }

    /// A tracker with a custom restart budget (used in tests).
    #[must_use]
    pub fn with_max(max_attempts: u32) -> Self {
        Self {
            state: RecoveryState::Healthy,
            max_attempts,
        }
    }

    /// The current recovery state.
    #[must_use]
    pub fn state(&self) -> RecoveryState {
        self.state
    }

    /// Whether the plugin has been auto-disabled.
    #[must_use]
    pub fn is_disabled(&self) -> bool {
        matches!(self.state, RecoveryState::Disabled)
    }

    /// Record a plugin failure and decide what to do.
    ///
    /// Increments the restart count; while it stays within the budget the caller
    /// should [`Restart`](RecoveryAction::Restart), and the tracker moves to
    /// [`Recovering`](RecoveryState::Recovering). The failure that would exceed
    /// the budget returns [`Disable`](RecoveryAction::Disable) and latches the
    /// tracker in [`Disabled`](RecoveryState::Disabled); every subsequent failure
    /// also returns `Disable` until [`record_success`](Self::record_success) or a
    /// reset.
    pub fn record_failure(&mut self) -> RecoveryAction {
        let attempts = match self.state {
            RecoveryState::Disabled => return RecoveryAction::Disable,
            RecoveryState::Healthy => 0,
            RecoveryState::Recovering { attempts } => attempts,
        };
        let next = attempts + 1;
        if next > self.max_attempts {
            self.state = RecoveryState::Disabled;
            RecoveryAction::Disable
        } else {
            self.state = RecoveryState::Recovering { attempts: next };
            RecoveryAction::Restart
        }
    }

    /// Record that the plugin is running healthily again, resetting the counter.
    pub fn record_success(&mut self) {
        self.state = RecoveryState::Healthy;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::manifest::parse_manifest;

    fn manifest_with(permissions: &str, filesystem_paths: &str) -> PluginManifest {
        let fs_line = if filesystem_paths.is_empty() {
            String::new()
        } else {
            format!("\"filesystemPaths\": {filesystem_paths},")
        };
        let json = format!(
            r#"{{
                "id": "sec-test",
                "name": "Sec Test",
                "version": "1.0.0",
                "author": "tester",
                "description": "security test plugin",
                "license": "MIT",
                "apiVersion": "1.0",
                "platforms": ["linux", "macos", "windows"],
                "permissions": {permissions},
                {fs_line}
                "extensions": {{
                    "terminalBackend": {{
                        "connectionType": "sec",
                        "displayName": "Sec",
                        "configSchema": {{}}
                    }}
                }}
            }}"#
        );
        parse_manifest(&json).expect("manifest should parse")
    }

    #[test]
    fn grants_and_require_reflect_declared_permissions() {
        let m = manifest_with(r#"["terminal", "network"]"#, "");
        let perms = PermissionSet::from_manifest(&m);
        assert!(perms.grants(PluginPermission::Terminal));
        assert!(perms.grants(PluginPermission::Network));
        assert!(!perms.grants(PluginPermission::Filesystem));

        assert!(perms.require(PluginPermission::Network).is_ok());
        // A backend plugin without `network` is denied the network capability.
        let no_net = PermissionSet::from_manifest(&manifest_with(r#"["terminal"]"#, ""));
        assert_eq!(
            no_net.require(PluginPermission::Network),
            Err(PermissionError::Denied(PluginPermission::Network))
        );
    }

    #[test]
    fn consistency_requires_terminal_permission_for_backend() {
        // Terminal backend but no `terminal` permission → rejected.
        let m = manifest_with(r#"["network"]"#, "");
        let perms = PermissionSet::from_manifest(&m);
        assert_eq!(
            perms.check_consistency(&m.extensions),
            Err(PermissionError::TerminalWithoutPermission)
        );

        // With the permission it is consistent.
        let ok = manifest_with(r#"["terminal"]"#, "");
        assert!(PermissionSet::from_manifest(&ok)
            .check_consistency(&ok.extensions)
            .is_ok());
    }

    #[test]
    fn consistency_ties_filesystem_permission_and_paths() {
        // filesystem permission but no declared paths → rejected.
        let no_paths = manifest_with(r#"["terminal", "filesystem"]"#, "");
        assert_eq!(
            PermissionSet::from_manifest(&no_paths).check_consistency(&no_paths.extensions),
            Err(PermissionError::FilesystemWithoutPaths)
        );

        // declared paths but no filesystem permission → rejected.
        let no_perm = manifest_with(r#"["terminal"]"#, r#"["/data"]"#);
        assert_eq!(
            PermissionSet::from_manifest(&no_perm).check_consistency(&no_perm.extensions),
            Err(PermissionError::PathsWithoutFilesystem)
        );

        // both present → consistent.
        let ok = manifest_with(r#"["terminal", "filesystem"]"#, r#"["/data"]"#);
        assert!(PermissionSet::from_manifest(&ok)
            .check_consistency(&ok.extensions)
            .is_ok());
    }

    #[test]
    fn filesystem_scope_denies_without_permission() {
        let m = manifest_with(r#"["terminal"]"#, "");
        let perms = PermissionSet::from_manifest(&m);
        assert_eq!(
            perms.check_path(Path::new("/anything")),
            Err(PermissionError::Denied(PluginPermission::Filesystem))
        );
    }

    #[test]
    fn filesystem_scope_allows_declared_paths_only() {
        let m = manifest_with(
            r#"["terminal", "filesystem"]"#,
            r#"["/data/plugin", "/var/log/app"]"#,
        );
        let perms = PermissionSet::from_manifest(&m);

        // Inside a declared root (the root itself and a descendant).
        assert_eq!(
            perms.check_path(Path::new("/data/plugin")).unwrap(),
            PathBuf::from("/data/plugin")
        );
        assert_eq!(
            perms
                .check_path(Path::new("/data/plugin/sub/file.txt"))
                .unwrap(),
            PathBuf::from("/data/plugin/sub/file.txt")
        );
        assert!(perms.check_path(Path::new("/var/log/app/x.log")).is_ok());

        // Outside every declared root.
        assert!(matches!(
            perms.check_path(Path::new("/etc/passwd")),
            Err(PermissionError::PathOutsideScope { .. })
        ));
        // A sibling that merely shares a prefix string is not contained.
        assert!(matches!(
            perms.check_path(Path::new("/data/plugin-evil/secret")),
            Err(PermissionError::PathOutsideScope { .. })
        ));
    }

    #[test]
    fn filesystem_scope_rejects_traversal_escape() {
        let m = manifest_with(r#"["terminal", "filesystem"]"#, r#"["/data/plugin"]"#);
        let perms = PermissionSet::from_manifest(&m);

        // `..` that climbs out of the declared root is rejected.
        for escape in [
            "/data/plugin/../../etc/passwd",
            "/data/plugin/../plugin-evil/x",
            "/data/../etc/shadow",
        ] {
            assert!(
                matches!(
                    perms.check_path(Path::new(escape)),
                    Err(PermissionError::PathOutsideScope { .. })
                ),
                "traversal {escape:?} should be rejected"
            );
        }

        // `..` that stays inside the root is fine and is normalized away.
        assert_eq!(
            perms
                .check_path(Path::new("/data/plugin/sub/../file.txt"))
                .unwrap(),
            PathBuf::from("/data/plugin/file.txt")
        );
    }

    #[test]
    fn normalize_lexical_cannot_escape_root() {
        // A pile of `..` at the root collapses to the root, never above it.
        assert_eq!(
            normalize_lexical(Path::new("/../../../etc")),
            PathBuf::from("/etc")
        );
    }

    #[test]
    fn assess_trust_is_always_untrusted() {
        let a = assess_trust(Path::new("/tmp/whatever.termihub-plugin"));
        assert_eq!(a.level, TrustLevel::Untrusted);
        assert!(a.requires_acceptance());
        assert!(!a.warning.is_empty());
    }

    #[test]
    fn restart_tracker_restarts_up_to_max_then_disables() {
        let mut t = RestartTracker::new();
        assert_eq!(t.state(), RecoveryState::Healthy);

        // Three failures each ask for a restart.
        for attempt in 1..=MAX_RESTART_ATTEMPTS {
            assert_eq!(t.record_failure(), RecoveryAction::Restart);
            assert_eq!(t.state(), RecoveryState::Recovering { attempts: attempt });
        }
        // The fourth failure exceeds the budget → auto-disable, and it latches.
        assert_eq!(t.record_failure(), RecoveryAction::Disable);
        assert!(t.is_disabled());
        assert_eq!(t.record_failure(), RecoveryAction::Disable);
    }

    #[test]
    fn restart_tracker_success_resets_the_counter() {
        let mut t = RestartTracker::with_max(2);
        assert_eq!(t.record_failure(), RecoveryAction::Restart);
        assert_eq!(t.record_failure(), RecoveryAction::Restart);
        // A healthy run resets, so the budget is available again.
        t.record_success();
        assert_eq!(t.state(), RecoveryState::Healthy);
        assert_eq!(t.record_failure(), RecoveryAction::Restart);
        assert_eq!(t.record_failure(), RecoveryAction::Restart);
        assert_eq!(t.record_failure(), RecoveryAction::Disable);
    }
}
