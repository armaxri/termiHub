//! Process-level portable-mode launch tests (#3691, MT-PORT-01/02).
//!
//! The unit tests in `utils/portable.rs` check the detection rule against temp
//! directories, but never launch the real binary: the system-test harness
//! always sets `TERMIHUB_CONFIG_DIR`, which overrides portable mode. These tests
//! close that gap headlessly. Each one copies the built `termihub` binary into
//! a fresh temp directory that holds a `portable.marker` file or a `data/`
//! directory, then runs it **without** `TERMIHUB_CONFIG_DIR`.
//!
//! The pre-init CLI paths need no display, because they exit before any window
//! is built (`cli/mod.rs`, `lib.rs::run`):
//!
//! * `--list-workspaces` only reads the resolved config directory, so it can run
//!   on every platform. The tests seed `data/workspaces.json` and assert that the
//!   listing comes from the portable directory.
//! * `uninstall-shell-integration` writes `settings.json` into the resolved
//!   config directory. That is the write path: the file must land under the
//!   portable `data/`, and nothing may appear in the system profile.
//!
//! Every run points `HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `APPDATA` /
//! `LOCALAPPDATA` at a throwaway directory, so a broken detection rule writes
//! there and never into the real profile. The write-path tests are skipped on
//! Windows. There the config dir comes from the Known Folder API, which ignores
//! these variables, and uninstalling also edits the real HKCU registry.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

/// The bundle identifier the installed-mode config directory is named after.
#[cfg(not(windows))]
const APP_IDENTIFIER: &str = "com.termihub.app";

/// How the portable root marks itself as portable.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(windows, allow(dead_code))]
enum PortableFlavor {
    /// An empty `portable.marker` file next to the binary (MT-PORT-01).
    Marker,
    /// A `data/` directory next to the binary, no marker (MT-PORT-02).
    DataDir,
    /// Neither: the binary runs in installed mode (the control case).
    Installed,
}

/// A copied binary in its own root directory, plus a throwaway profile home.
struct PortableLaunch {
    _tmp: TempDir,
    root: PathBuf,
    home: PathBuf,
    exe: PathBuf,
}

impl PortableLaunch {
    fn new(flavor: PortableFlavor) -> Self {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let root = tmp.path().join("portable-root");
        let home = tmp.path().join("profile-home");
        fs::create_dir_all(&root).expect("create portable root");
        fs::create_dir_all(&home).expect("create profile home");

        let built = PathBuf::from(env!("CARGO_BIN_EXE_termihub"));
        let exe = root.join(built.file_name().expect("binary file name"));
        // A hard link is instant and keeps the link path as the process's
        // `current_exe`. Fall back to a copy across filesystems.
        if fs::hard_link(&built, &exe).is_err() {
            fs::copy(&built, &exe).expect("copy termihub binary into the portable root");
        }

        match flavor {
            PortableFlavor::Marker => {
                fs::write(root.join("portable.marker"), b"").expect("write portable.marker");
            }
            PortableFlavor::DataDir => {
                fs::create_dir_all(root.join("data")).expect("create data/");
            }
            PortableFlavor::Installed => {}
        }

        Self {
            _tmp: tmp,
            root,
            home,
            exe,
        }
    }

    fn data_dir(&self) -> PathBuf {
        self.root.join("data")
    }

    /// Run the copied binary with `args`, isolated from the real profile and
    /// with any inherited `TERMIHUB_CONFIG_DIR` removed.
    fn run(&self, args: &[&str]) -> Output {
        let home = &self.home;
        Command::new(&self.exe)
            .args(args)
            .current_dir(&self.root)
            .env_remove("TERMIHUB_CONFIG_DIR")
            .env("HOME", home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("XDG_CACHE_HOME", home.join(".cache"))
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .output()
            .expect("launch the copied termihub binary")
    }

    /// The installed-mode config directory inside the throwaway home, i.e. where
    /// `dirs::config_dir()` + the bundle id points on this platform.
    #[cfg(not(windows))]
    fn profile_config_dir(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            self.home
                .join("Library/Application Support")
                .join(APP_IDENTIFIER)
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.home.join(".config").join(APP_IDENTIFIER)
        }
    }
}

/// Every path under `dir` whose file name mentions termiHub, relative to `dir`.
#[cfg(not(windows))]
fn termihub_entries_under(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.contains("termihub") {
                found.push(path.strip_prefix(dir).unwrap_or(&path).to_path_buf());
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    found
}

fn describe(output: &Output) -> String {
    format!(
        "status={:?}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Seed `data/workspaces.json` with one uniquely-named workspace and return
/// that name.
fn seed_portable_workspace(launch: &PortableLaunch) -> String {
    let name = format!("portable-ws-{}", std::process::id());
    fs::create_dir_all(launch.data_dir()).expect("create data/");
    let doc = format!(
        r#"{{"version":"2","workspaces":[{{"id":"ws-portable","name":"{name}","tabGroups":[]}}]}}"#
    );
    fs::write(launch.data_dir().join("workspaces.json"), doc).expect("seed workspaces.json");
    name
}

fn assert_lists_portable_workspace(flavor: PortableFlavor) {
    let launch = PortableLaunch::new(flavor);
    let name = seed_portable_workspace(&launch);

    let output = launch.run(&["--list-workspaces"]);
    assert!(output.status.success(), "{}", describe(&output));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(&name),
        "--list-workspaces must read the portable data/ dir; {}",
        describe(&output)
    );
}

/// MT-PORT-01: `portable.marker` makes the real binary resolve its config from
/// `<binary-dir>/data/`.
#[test]
fn marker_launch_reads_config_from_portable_data_dir() {
    assert_lists_portable_workspace(PortableFlavor::Marker);
}

/// MT-PORT-02: a bare `data/` directory (no marker) does the same.
#[test]
fn data_dir_launch_reads_config_from_portable_data_dir() {
    assert_lists_portable_workspace(PortableFlavor::DataDir);
}

/// Control: in installed mode the same binary lists the workspaces stored in
/// the throwaway profile. This proves the profile redirection works, so the two
/// tests above cannot pass by reading some other location.
#[cfg(not(windows))]
#[test]
fn installed_launch_reads_config_from_the_profile() {
    let launch = PortableLaunch::new(PortableFlavor::Installed);
    let profile = launch.profile_config_dir();
    fs::create_dir_all(&profile).expect("create profile config dir");
    fs::write(
        profile.join("workspaces.json"),
        r#"{"version":"2","workspaces":[{"id":"ws-profile","name":"profile-ws","tabGroups":[]}]}"#,
    )
    .expect("seed profile workspaces.json");

    let output = launch.run(&["--list-workspaces"]);
    assert!(output.status.success(), "{}", describe(&output));
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("profile-ws"),
        "installed mode must read the profile config dir; {}",
        describe(&output)
    );
    assert!(
        !launch.data_dir().exists(),
        "installed mode must not create a data/ dir next to the binary"
    );
}

/// Write path: run a config-writing CLI command and assert where it wrote.
#[cfg(not(windows))]
fn assert_writes_only_under_portable_dir(flavor: PortableFlavor) {
    let launch = PortableLaunch::new(flavor);

    let output = launch.run(&["uninstall-shell-integration"]);
    assert!(output.status.success(), "{}", describe(&output));
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("Shell integration removed."),
        "{}",
        describe(&output)
    );

    let settings = launch.data_dir().join("settings.json");
    assert!(
        settings.is_file(),
        "settings.json must be written under the portable data/ dir ({}); {}",
        settings.display(),
        describe(&output)
    );
    assert!(
        !launch.profile_config_dir().exists(),
        "portable mode must not create the profile config dir {}",
        launch.profile_config_dir().display()
    );
    let leaked = termihub_entries_under(&launch.home);
    assert!(
        leaked.is_empty(),
        "portable mode wrote termiHub files into the profile home: {leaked:?}"
    );
}

/// MT-PORT-01 write path: with `portable.marker`, config lands in `data/` (which
/// the app creates) and nothing in the profile.
#[cfg(not(windows))]
#[test]
fn marker_launch_writes_config_only_under_portable_data_dir() {
    assert_writes_only_under_portable_dir(PortableFlavor::Marker);
}

/// MT-PORT-02 write path: with a bare `data/`, config lands there and nothing
/// in the profile.
#[cfg(not(windows))]
#[test]
fn data_dir_launch_writes_config_only_under_portable_data_dir() {
    assert_writes_only_under_portable_dir(PortableFlavor::DataDir);
}

/// Control for the write path: an installed-mode launch writes into the
/// throwaway profile, never a `data/` next to the binary. This proves the
/// profile redirection works, so the "nothing in the profile" assertions above
/// would catch a real leak.
#[cfg(not(windows))]
#[test]
fn installed_launch_writes_config_into_the_profile() {
    let launch = PortableLaunch::new(PortableFlavor::Installed);

    let output = launch.run(&["uninstall-shell-integration"]);
    assert!(output.status.success(), "{}", describe(&output));
    assert!(
        launch.profile_config_dir().join("settings.json").is_file(),
        "installed mode must write settings.json into {}; {}",
        launch.profile_config_dir().display(),
        describe(&output)
    );
    assert!(
        !launch.data_dir().exists(),
        "installed mode must not create a data/ dir next to the binary"
    );
}
