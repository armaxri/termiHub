//! Windows: AppContainer profile and ACL edits from two processes at once
//! (#5359).
//!
//! Two termiHub instances (or two nextest test processes) share the per-user
//! AppContainer profiles and the runner's ACL. An in-process lock does not
//! serialise them: concurrent `CreateAppContainerProfile` calls for one name
//! fail with `0x8000ffff` / `ERROR_BAD_ENVIRONMENT` and roll the other's
//! profile back, and two read-modify-writes of one DACL lose an entry.
//!
//! [`two_processes_edit_profiles_and_acls_at_once`] starts this test binary
//! twice more, running only [`cross_process_child`] with
//! [`ROLE_ENV`] set, so the children hammer one shared profile and one set of
//! files at the same time. Without the variable the child test is a no-op.
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use termihub_plugin_runner::appcontainer::{
    delete_profile, delete_profile_revoking, AppContainer, READ_EXECUTE,
};

/// Set on a child: its index (`0`, `1`).
const ROLE_ENV: &str = "TERMIHUB_APPCONTAINER_XPROC_ROLE";
/// Set on a child: the shared work folder (the go flag, the files to grant).
const DIR_ENV: &str = "TERMIHUB_APPCONTAINER_XPROC_DIR";
/// Set on a child: the parent's base plugin id.
const ID_ENV: &str = "TERMIHUB_APPCONTAINER_XPROC_ID";

const CHILDREN: usize = 2;
/// Ensure/delete rounds on the shared profile, per child.
const PROFILE_ROUNDS: usize = 25;
/// Grant/revoke rounds over the shared files, per child.
const ACL_ROUNDS: usize = 5;
/// Files both children grant their own SID on, in the same order.
const FILES: usize = 8;
const CHILD_DEADLINE: Duration = Duration::from_secs(240);

/// The profile both children create and delete over and over.
fn shared_id(base: &str) -> String {
    format!("{base}-shared")
}

/// Child `role`'s own profile, whose SID it grants on the shared files.
fn own_id(base: &str, role: usize) -> String {
    format!("{base}-child{role}")
}

fn files(dir: &Path) -> Vec<PathBuf> {
    (0..FILES)
        .map(|i| dir.join(format!("file{i}.exe")))
        .collect()
}

fn go_flag(dir: &Path) -> PathBuf {
    dir.join("go")
}

fn done_marker(dir: &Path, role: usize) -> PathBuf {
    dir.join(format!("done{role}"))
}

/// The DACL of `path` as `icacls` prints it; an AppContainer SID shows as
/// its `S-1-15-2-…` string.
fn acl_of(path: &Path) -> String {
    let out = Command::new("icacls")
        .arg(path)
        .output()
        .expect("run icacls");
    assert!(out.status.success(), "icacls {}: {out:?}", path.display());
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Both children run at once: each creates and deletes the shared profile
/// repeatedly, and grants then revokes its own SID on the same files. Every
/// call succeeds, and once both are done every file carries both children's
/// final grants (no read-modify-write lost the other's entry).
#[test]
fn two_processes_edit_profiles_and_acls_at_once() {
    let base = format!("appcontainer-xproc-{}", std::process::id());
    let work = tempfile::TempDir::new().unwrap();
    for file in files(work.path()) {
        std::fs::write(&file, b"x").unwrap();
    }
    let exe = std::env::current_exe().unwrap();
    let children: Vec<_> = (0..CHILDREN)
        .map(|role| {
            Command::new(&exe)
                .args(["cross_process_child", "--exact", "--nocapture"])
                .env(ROLE_ENV, role.to_string())
                .env(DIR_ENV, work.path())
                .env(ID_ENV, &base)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    // Both are started: let them go together, so their edits overlap.
    std::fs::write(go_flag(work.path()), b"go").unwrap();

    let outputs: Vec<_> = children
        .into_iter()
        .map(|child| child.wait_with_output().unwrap())
        .collect();
    for (role, out) in outputs.iter().enumerate() {
        assert!(
            out.status.success(),
            "child {role} failed: {}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // The filter matched and the child really ran (not "0 tests").
        assert!(
            done_marker(work.path(), role).exists(),
            "child {role} did not run: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }

    let sids: Vec<String> = (0..CHILDREN)
        .map(|role| {
            AppContainer::ensure(&own_id(&base, role))
                .unwrap()
                .sid_string()
                .to_owned()
        })
        .collect();
    for file in files(work.path()) {
        let acl = acl_of(&file);
        for sid in &sids {
            assert!(
                acl.contains(sid.as_str()),
                "`{}` lost the grant for {sid}:\n{acl}",
                file.display()
            );
        }
    }
    for role in 0..CHILDREN {
        let id = own_id(&base, role);
        let all = files(work.path());
        let objects: Vec<&Path> = all.iter().map(PathBuf::as_path).collect();
        let failures = delete_profile_revoking(&id, &objects).unwrap();
        assert!(failures.is_empty(), "{failures:?}");
    }
    delete_profile(&shared_id(&base)).unwrap();
}

/// The child half of [`two_processes_edit_profiles_and_acls_at_once`]; a
/// no-op unless [`ROLE_ENV`] is set.
#[test]
fn cross_process_child() {
    let Ok(role) = std::env::var(ROLE_ENV) else {
        return;
    };
    let role: usize = role.parse().unwrap();
    let dir = PathBuf::from(std::env::var_os(DIR_ENV).unwrap());
    let base = std::env::var(ID_ENV).unwrap();
    let deadline = Instant::now() + CHILD_DEADLINE;
    while !go_flag(&dir).exists() {
        assert!(Instant::now() < deadline, "no go flag");
        std::thread::sleep(Duration::from_millis(5));
    }

    let shared = shared_id(&base);
    for round in 0..PROFILE_ROUNDS {
        let container = AppContainer::ensure(&shared)
            .unwrap_or_else(|e| panic!("child {role} round {round}: ensure: {e}"));
        assert!(container.sid_string().starts_with("S-1-15-2-"));
        delete_profile(&shared)
            .unwrap_or_else(|e| panic!("child {role} round {round}: delete: {e}"));
    }

    let own = own_id(&base, role);
    let all = files(&dir);
    let objects: Vec<&Path> = all.iter().map(PathBuf::as_path).collect();
    for round in 0..=ACL_ROUNDS {
        let container = AppContainer::ensure(&own)
            .unwrap_or_else(|e| panic!("child {role} round {round}: ensure: {e}"));
        for file in &all {
            container
                .grant_object(file, READ_EXECUTE)
                .unwrap_or_else(|e| panic!("child {role}: grant `{}`: {e}", file.display()));
        }
        if round == ACL_ROUNDS {
            // The last round's grants stay, for the parent to check.
            break;
        }
        let failures = delete_profile_revoking(&own, &objects)
            .unwrap_or_else(|e| panic!("child {role} round {round}: revoke: {e}"));
        assert!(failures.is_empty(), "child {role}: {failures:?}");
    }
    std::fs::write(done_marker(&dir, role), b"done").unwrap();
}
