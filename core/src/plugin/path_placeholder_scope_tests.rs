//! `${home}`/`${config}` placeholders in `filesystemPaths` (#4533), exercised
//! through the real policy layers: manifest validation, the permission set's
//! filesystem scope, the load-time protected-folder checks, and the native
//! trust binding.

#[cfg(unix)]
use std::path::Path;
use std::path::PathBuf;

use tempfile::TempDir;

use super::manifest::{parse_manifest, PluginManifest};
use super::native_trust::ApprovedAccess;
use super::path_placeholders::{PlaceholderBases, UNKNOWN_PLACEHOLDER};
use super::security::{PermissionError, PermissionSet};
use super::{ManifestValidationError, PluginPermission};

/// A terminal-backend manifest with the `filesystem` permission and the given
/// `filesystemPaths` JSON array.
fn manifest(paths: &str) -> PluginManifest {
    let json = format!(
        r#"{{
            "id": "ph-test", "name": "Placeholder Test", "version": "1.0.0",
            "author": "tester", "description": "d", "license": "MIT",
            "apiVersion": "1.0", "platforms": ["linux", "macos", "windows"],
            "permissions": ["terminal", "filesystem"],
            "filesystemPaths": {paths},
            "extensions": {{ "terminalBackend": {{
                "connectionType": "ph", "displayName": "Ph", "configSchema": {{}}
            }} }}
        }}"#
    );
    parse_manifest(&json).expect("manifest parses")
}

/// A temporary home folder (and a config folder inside it), as real
/// directories so canonicalisation and symlinks behave as on a real host.
struct Host {
    tmp: TempDir,
}

impl Host {
    fn new() -> Self {
        let host = Self {
            tmp: TempDir::new().unwrap(),
        };
        std::fs::create_dir_all(host.app_dir()).unwrap();
        host
    }

    fn home(&self) -> PathBuf {
        self.tmp.path().join("home").join("alice")
    }

    fn config(&self) -> PathBuf {
        self.home().join(".config")
    }

    /// termiHub's own config folder (the plugins root's parent).
    fn app_dir(&self) -> PathBuf {
        self.config().join("termihub")
    }

    fn bases(&self) -> PlaceholderBases {
        PlaceholderBases::new(
            Some(self.home().to_str().unwrap()),
            Some(self.config().to_str().unwrap()),
        )
    }

    fn permissions(&self, paths: &[&str]) -> PermissionSet {
        let owned: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
        PermissionSet::from_parts_with_bases(
            [PluginPermission::Terminal, PluginPermission::Filesystem],
            &owned,
            &self.bases(),
        )
    }

    /// The load-time breadth checks `PluginHost::load` runs.
    fn load_checks(&self, perms: &PermissionSet) -> Result<(), PermissionError> {
        let plugins = self.app_dir().join("plugins");
        perms.check_protected_folders(Some(&self.home()), &[&plugins, &self.app_dir()])
    }
}

#[test]
fn manifest_validation_accepts_known_placeholders() {
    for good in [
        r#"["${home}/.kube"]"#,
        r#"["${config}/k8s-exec"]"#,
        r#"["${home}/captures/app", "/var/log/app"]"#,
    ] {
        manifest(good)
            .validate()
            .unwrap_or_else(|e| panic!("{good} must validate: {e}"));
    }
}

#[test]
fn manifest_validation_rejects_bad_placeholders() {
    for (bad, reason) in [
        (r#"["${HOME}/.kube"]"#, UNKNOWN_PLACEHOLDER),
        (r#"["${env}/x"]"#, UNKNOWN_PLACEHOLDER),
        (r#"["${home"]"#, UNKNOWN_PLACEHOLDER),
        (r#"["/data/${home}/x"]"#, UNKNOWN_PLACEHOLDER),
        (
            r#"["${home}"]"#,
            "is your whole home folder, which is too broad",
        ),
        (
            r#"["${config}"]"#,
            "is your whole config folder, which contains termiHub's own settings",
        ),
        (r#"["${home}/../etc"]"#, "contains a `.` or `..` segment"),
    ] {
        let err = manifest(bad).validate().unwrap_err();
        match err {
            ManifestValidationError::InvalidFilesystemPath { reason: got, .. } => {
                // A placeholder misplaced after the first segment is caught
                // either by the placeholder parser or the absolute-path check.
                assert!(
                    got == reason || got == "uses a placeholder that is not the first segment",
                    "{bad}: unexpected reason {got:?}"
                );
            }
            other => panic!("{bad}: unexpected error {other:?}"),
        }
    }
}

#[test]
fn scope_grants_the_resolved_folder_only() {
    let host = Host::new();
    std::fs::create_dir_all(host.home().join(".kube")).unwrap();
    std::fs::write(host.home().join(".kube").join("config"), b"k").unwrap();
    std::fs::write(host.home().join("secret"), b"s").unwrap();
    let perms = host.permissions(&["${home}/.kube"]);

    assert_eq!(perms.filesystem().roots(), &[host.home().join(".kube")]);
    perms
        .check_consistency(&manifest(r#"["${home}/.kube"]"#).extensions)
        .expect("consistent");
    host.load_checks(&perms).expect("not over-broad");

    assert!(perms
        .check_path(&host.home().join(".kube").join("config"))
        .is_ok());
    for outside in [
        host.home().join("secret"),
        host.home().join(".kube").join("..").join("secret"),
        host.home(),
    ] {
        assert!(
            matches!(
                perms.check_path(&outside),
                Err(PermissionError::PathOutsideScope { .. })
            ),
            "{} must be outside the scope",
            outside.display()
        );
    }
}

#[test]
fn config_placeholder_resolves_below_the_config_folder() {
    let host = Host::new();
    let perms = host.permissions(&["${config}/k8s-exec"]);
    assert_eq!(
        perms.filesystem().roots(),
        &[host.config().join("k8s-exec")]
    );
    host.load_checks(&perms)
        .expect("a sibling of termiHub's folder is fine");
}

#[test]
fn invalid_or_unresolvable_placeholders_fail_the_load() {
    let host = Host::new();
    let extensions = manifest(r#"["/x/y"]"#).extensions;
    for bad in ["${home}", "${HOME}/x", "${home}/../x", "${home}/x\\..\\y"] {
        let perms = host.permissions(&[bad]);
        assert!(
            perms.filesystem().roots().is_empty(),
            "{bad} granted a root"
        );
        assert!(
            matches!(
                perms.check_consistency(&extensions),
                Err(PermissionError::InvalidFilesystemPath { .. })
            ),
            "{bad} must fail the load"
        );
    }
    // No home folder on this host: `${home}` cannot resolve, so it is refused
    // rather than guessed.
    let perms = PermissionSet::from_parts_with_bases(
        [PluginPermission::Terminal, PluginPermission::Filesystem],
        &["${home}/.kube".to_owned()],
        &PlaceholderBases::new(None, None),
    );
    assert!(perms.filesystem().roots().is_empty());
    assert!(matches!(
        perms.check_consistency(&extensions),
        Err(PermissionError::InvalidFilesystemPath { .. })
    ));
}

#[test]
fn resolved_roots_still_hit_the_protected_folder_deny_list() {
    let host = Host::new();
    // `${home}/.config` contains termiHub's own config folder; so does the
    // termiHub folder itself and anything inside it.
    for refused in [
        "${home}/.config",
        "${config}/termihub",
        "${config}/termihub/plugins/other",
    ] {
        assert!(
            matches!(
                host.load_checks(&host.permissions(&[refused])),
                Err(PermissionError::OverBroadFilesystemPath { .. })
            ),
            "{refused} must be refused"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_symlink_cannot_carry_a_placeholder_root_out_of_its_folder() {
    use std::os::unix::fs::symlink;

    let host = Host::new();
    let outside = host.tmp.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(host.home()).unwrap();
    symlink(&outside, host.home().join(".kube")).unwrap();
    symlink(host.home(), host.home().join("self")).unwrap();
    symlink(
        host.tmp.path().join("missing"),
        host.home().join("dangling"),
    )
    .unwrap();

    for escaping in ["${home}/.kube", "${home}/self", "${home}/dangling"] {
        let err = host
            .load_checks(&host.permissions(&[escaping]))
            .expect_err("a symlinked root leaving home must be refused");
        assert!(
            matches!(err, PermissionError::OverBroadFilesystemPath { .. }),
            "{escaping}: unexpected {err:?}"
        );
    }

    // A symlink *inside* the resolved root keeps the existing guard: reads
    // through it are refused.
    let root = host.home().join("captures");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(outside.join("secret"), b"s").unwrap();
    symlink(&outside, root.join("escape")).unwrap();
    let perms = host.permissions(&["${home}/captures"]);
    host.load_checks(&perms).expect("a real folder below home");
    assert!(matches!(
        perms.check_path(&root.join("escape").join("secret")),
        Err(PermissionError::PathOutsideScope { .. })
    ));
}

#[cfg(unix)]
#[test]
fn a_symlinked_home_folder_still_matches_its_own_children() {
    use std::os::unix::fs::symlink;

    // `/home -> /usr/home`-style hosts: the base folder itself is a symlink,
    // and a real folder below it must still be accepted.
    let tmp = TempDir::new().unwrap();
    let real_home = tmp.path().join("real-home");
    std::fs::create_dir_all(real_home.join("captures")).unwrap();
    let linked_home = tmp.path().join("home");
    symlink(&real_home, &linked_home).unwrap();
    let bases = PlaceholderBases::new(Some(linked_home.to_str().unwrap()), None);
    let perms = PermissionSet::from_parts_with_bases(
        [PluginPermission::Filesystem],
        &["${home}/captures".to_owned()],
        &bases,
    );
    perms
        .check_protected_folders(Some(&linked_home), &[Path::new("/nonexistent/termihub")])
        .expect("a real folder below a symlinked home is allowed");
}

#[test]
fn trust_binds_the_resolved_folder() {
    let alice = PlaceholderBases::new(Some("/home/alice"), Some("/home/alice/.config"));
    let bob = PlaceholderBases::new(Some("/home/bob"), Some("/home/bob/.config"));
    let placeholder = manifest(r#"["${home}/.kube"]"#);
    let literal = manifest(r#"["/home/alice/.kube"]"#);

    let approved = ApprovedAccess::from_manifest_with_bases(&placeholder, &alice);
    assert_eq!(
        approved.filesystem_paths,
        vec!["/home/alice/.kube".to_owned()]
    );
    // The same folder declared literally is the same access …
    assert_eq!(
        ApprovedAccess::from_manifest_with_bases(&literal, &alice),
        approved
    );
    // … but if the placeholder resolves elsewhere, consent no longer matches
    // and the trust surface lists the new folder.
    let moved = ApprovedAccess::from_manifest_with_bases(&placeholder, &bob);
    assert_ne!(moved, approved);
    assert_eq!(
        moved.added_since(Some(&approved)),
        vec!["/home/bob/.kube".to_owned()]
    );
}
