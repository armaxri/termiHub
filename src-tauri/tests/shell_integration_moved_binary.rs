//! Process-level "moved installed binary" shell-integration test (#3691, SI-5/6/7).
//!
//! The staleness rule (`commands/shell_integration.rs::status_from_runtime`)
//! is unit-tested, but nothing ran the real binary through the whole flow:
//! register from one location, move the binary, then reinstall from the new
//! location. This test does that headlessly with the pre-init
//! `install-shell-integration` / `uninstall-shell-integration` CLI, which exits
//! before any window is built.
//!
//! 1. Copy the built binary to `old/` and run `install-shell-integration` there
//!    with one configured entry. `settings.json` records `old/termihub`, and the
//!    per-user surfaces (XDG `.desktop` launcher on Linux, Quick Action bundle on
//!    macOS) invoke it.
//! 2. "Move" the binary: copy it to `new/` and delete `old/`. The recorded
//!    `registeredExePath` now differs from the running executable, which is
//!    exactly what makes the app show the stale banner.
//! 3. Reinstall from `new/`. The registration must point at `new/termihub`, and
//!    no surface may still invoke the removed `old/` path.
//! 4. Uninstall removes every surface and clears the registration.
//!
//! The UI half (the banner appears for the moved binary, and the Reinstall
//! button clears it) is `tests/system/tests/test_shell_integration_moved.py`
//! in the nightly integration lane.
//!
//! Isolation: `TERMIHUB_CONFIG_DIR`, `HOME`, `XDG_DATA_HOME` and
//! `XDG_CONFIG_HOME` all point into a throwaway directory, so the real
//! `~/Library/Services`, `~/.local/share/applications` and termiHub settings are
//! never read or written. Skipped on Windows, where registration writes the
//! real HKCU registry.
#![cfg(not(windows))]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::Value;
use tempfile::TempDir;

/// A throwaway profile + config dir and the binary copies run against it.
struct Sandbox {
    tmp: TempDir,
}

impl Sandbox {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("create temp dir");
        for dir in ["home/.local/share", "home/.config", "config"] {
            fs::create_dir_all(tmp.path().join(dir)).expect("create sandbox dir");
        }
        Self { tmp }
    }

    fn home(&self) -> PathBuf {
        self.tmp.path().join("home")
    }

    fn settings_path(&self) -> PathBuf {
        self.tmp.path().join("config").join("settings.json")
    }

    /// Copy the built binary into `<sandbox>/<dir>/` and return the copy's path.
    fn stage_binary(&self, dir: &str) -> PathBuf {
        let built = PathBuf::from(env!("CARGO_BIN_EXE_termihub"));
        let root = self.tmp.path().join(dir);
        fs::create_dir_all(&root).expect("create binary dir");
        let exe = root.join(built.file_name().expect("binary file name"));
        stage_exe(&built, &exe);
        exe
    }

    /// Run `exe` with `args` against the sandboxed profile and config dir.
    fn run(&self, exe: &Path, args: &[&str]) -> Output {
        let home = self.home();
        Command::new(exe)
            .args(args)
            .current_dir(self.tmp.path())
            .env("TERMIHUB_CONFIG_DIR", self.tmp.path().join("config"))
            .env("HOME", &home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .output()
            .expect("launch the copied termihub binary")
    }

    /// Run a shell-integration subcommand and assert it succeeded.
    fn run_ok(&self, exe: &Path, subcommand: &str, expected_line: &str) {
        let output = self.run(exe, &[subcommand]);
        assert!(output.status.success(), "{}", describe(&output));
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line == expected_line),
            "{subcommand} did not print {expected_line:?}; {}",
            describe(&output)
        );
    }

    fn read_settings(&self) -> Value {
        let text = fs::read_to_string(self.settings_path()).expect("read settings.json");
        serde_json::from_str(&text).expect("parse settings.json")
    }

    /// The persisted `shellIntegration` block.
    fn shell_integration(&self) -> Value {
        self.read_settings()
            .get("shellIntegration")
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Add one always-visible entry, so install writes a per-user surface.
    fn seed_entry(&self) {
        let mut doc = self.read_settings();
        let si = doc
            .as_object_mut()
            .expect("settings.json is an object")
            .entry("shellIntegration")
            .or_insert_with(|| Value::Object(Default::default()));
        si["entries"] = serde_json::json!([{
            "id": "moved-smoke",
            "name": "Open in termiHub Moved Smoke",
            "visibility": "always",
            "showFor": { "folders": true, "files": false, "folderBackground": true }
        }]);
        fs::write(
            self.settings_path(),
            serde_json::to_string_pretty(&doc).expect("serialize settings.json"),
        )
        .expect("write settings.json");
    }

    /// Files under the sandboxed home whose contents mention `needle`.
    fn surfaces_mentioning(&self, needle: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![self.home()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if fs::read_to_string(&path).is_ok_and(|text| text.contains(needle)) {
                    found.push(path);
                }
            }
        }
        found
    }
}

/// Put the built binary at `exe`, so that the process reports `exe` as its
/// `current_exe`.
///
/// Linux and Windows use a hard link, which is instant. macOS resolves
/// `current_exe` of a hard link through the shared vnode and can report a
/// *sibling* link's path (another test's copy, or the build output), so it
/// always copies. `fs::copy` makes an instant APFS clone there.
fn stage_exe(built: &Path, exe: &Path) {
    if cfg!(not(target_os = "macos")) && fs::hard_link(built, exe).is_ok() {
        return;
    }
    fs::copy(built, exe).expect("copy termihub binary");
}

fn describe(output: &Output) -> String {
    format!(
        "status={:?}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn exe_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// SI-5/6/7: register, move the binary, reinstall from the new location.
#[test]
fn reinstall_after_moving_the_binary_repoints_every_surface() {
    let sandbox = Sandbox::new();
    let old_exe = sandbox.stage_binary("old");
    let old_path = exe_str(&old_exe);

    // 1. Register from the original location with one configured entry.
    sandbox.run_ok(
        &old_exe,
        "install-shell-integration",
        "Shell integration installed.",
    );
    sandbox.seed_entry();
    sandbox.run_ok(
        &old_exe,
        "install-shell-integration",
        "Shell integration installed.",
    );
    let si = sandbox.shell_integration();
    assert_eq!(si["registered"], Value::Bool(true), "{si}");
    assert_eq!(
        si["registeredExePath"],
        Value::String(old_path.clone()),
        "{si}"
    );
    assert!(
        !sandbox.surfaces_mentioning(&old_path).is_empty(),
        "install wrote no per-user surface invoking {old_path}"
    );

    // 2. Move the binary: the registration now names a path that is gone.
    let new_exe = sandbox.stage_binary("new");
    let new_path = exe_str(&new_exe);
    fs::remove_dir_all(old_exe.parent().expect("old binary dir")).expect("remove old/");
    assert_ne!(
        sandbox.shell_integration()["registeredExePath"],
        Value::String(new_path.clone()),
        "the moved binary must start out stale"
    );

    // 3. Reinstall from the new location repoints the registration and surfaces.
    sandbox.run_ok(
        &new_exe,
        "install-shell-integration",
        "Shell integration installed.",
    );
    let si = sandbox.shell_integration();
    assert_eq!(si["registered"], Value::Bool(true), "{si}");
    assert_eq!(
        si["registeredExePath"],
        Value::String(new_path.clone()),
        "{si}"
    );
    assert!(
        !sandbox.surfaces_mentioning(&new_path).is_empty(),
        "reinstall wrote no per-user surface invoking {new_path}"
    );
    let stale = sandbox.surfaces_mentioning(&old_path);
    assert!(
        stale.is_empty(),
        "surfaces still invoke the moved-away binary {old_path}: {stale:?}"
    );

    // 4. Uninstall removes every surface and clears the registration.
    sandbox.run_ok(
        &new_exe,
        "uninstall-shell-integration",
        "Shell integration removed.",
    );
    let si = sandbox.shell_integration();
    assert_eq!(si["registered"], Value::Bool(false), "{si}");
    let left = sandbox.surfaces_mentioning(&new_path);
    assert!(left.is_empty(), "uninstall left surfaces behind: {left:?}");
}
