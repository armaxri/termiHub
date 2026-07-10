//! Windows Explorer context-menu registry registration (#1368).
//!
//! Part of the Shell Context Menu & CLI Spawn Integration epic (#1363). Writes
//! and removes the user-level (`HKCU\Software\Classes\…`) registry keys that make
//! configured [`ShellEntry`]s appear as "Open in termiHub" entries in Windows
//! Explorer's right-click menus — for folders, folder backgrounds, and files.
//!
//! All keys live under `HKEY_CURRENT_USER`, so **no administrator rights** are
//! required. Registration is idempotent: [`install`] first clears any prior
//! termiHub keys, then rewrites them from the current entry list.
//!
//! Everything here is Windows-specific. On other platforms the public
//! [`install`] / [`uninstall`] functions compile but return a clear
//! "unsupported on this platform" error, so the calling Tauri commands and CLI
//! subcommands behave predictably everywhere.

use crate::connection::shell_integration::ShellEntry;

/// Message returned by the install / uninstall entry points on non-Windows
/// platforms, where Explorer registry registration does not apply.
#[cfg(not(windows))]
const UNSUPPORTED_MESSAGE: &str =
    "Windows Explorer context-menu registration is only supported on Windows";

/// Register the given shell-integration entries as Explorer context-menu items.
///
/// Windows-only. Idempotent — an existing registration is replaced. `exe_path`
/// is the absolute path to the termiHub executable that the menu commands invoke.
#[cfg(windows)]
pub fn install(entries: &[ShellEntry], exe_path: &str) -> anyhow::Result<()> {
    imp::Registrar::system().install(entries, exe_path)
}

/// Remove every termiHub Explorer context-menu registration (Windows-only).
#[cfg(windows)]
pub fn uninstall() -> anyhow::Result<()> {
    imp::Registrar::system().uninstall()
}

/// Non-Windows stub: Explorer registry registration does not apply here.
#[cfg(not(windows))]
pub fn install(_entries: &[ShellEntry], _exe_path: &str) -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

/// Non-Windows stub: Explorer registry registration does not apply here.
#[cfg(not(windows))]
pub fn uninstall() -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

#[cfg(windows)]
mod imp {
    use super::ShellEntry;
    use anyhow::Result;

    /// Root registry location under which all class definitions live.
    const SYSTEM_CLASSES_ROOT: &str = r"Software\Classes";

    /// Writes and removes the per-entry Explorer context-menu registry keys.
    ///
    /// The `classes_root` is injectable so tests can target a throwaway HKCU
    /// subtree instead of the real `Software\Classes`.
    pub struct Registrar {
        classes_root: String,
    }

    impl Registrar {
        /// Registrar targeting the real per-user class store.
        pub fn system() -> Self {
            Self {
                classes_root: SYSTEM_CLASSES_ROOT.to_string(),
            }
        }

        /// Registrar targeting a throwaway subtree (`<subtree>\Classes`) so a
        /// test never touches the user's real Explorer registration.
        #[cfg(test)]
        pub fn for_test(subtree: &str) -> Self {
            Self {
                classes_root: format!(r"{subtree}\Classes"),
            }
        }

        /// Install the context-menu entries (idempotent).
        pub fn install(&self, _entries: &[ShellEntry], _exe_path: &str) -> Result<()> {
            let _ = &self.classes_root;
            anyhow::bail!("registry registration not yet implemented")
        }

        /// Remove every termiHub context-menu entry.
        pub fn uninstall(&self) -> Result<()> {
            let _ = &self.classes_root;
            anyhow::bail!("registry unregistration not yet implemented")
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::connection::shell_integration::{
            ShellEntry, ShellEntryVisibility, ShowForTargets,
        };
        use winreg::enums::*;
        use winreg::RegKey;

        const EXE: &str = r"C:\Program Files\termiHub\termiHub.exe";

        /// A throwaway HKCU subtree that is deleted on drop, so a test's registry
        /// writes never leak into the user's real Explorer configuration.
        struct TestScope {
            subtree: String,
            registrar: Registrar,
        }

        impl TestScope {
            fn new(tag: &str) -> Self {
                let subtree = format!(r"Software\termiHub-test-{}-{}", std::process::id(), tag);
                // Clear any leftover from a previous aborted run.
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&subtree);
                let registrar = Registrar::for_test(&subtree);
                Self { subtree, registrar }
            }

            /// Open a `shell`-relative subkey under this scope's class store.
            fn open(&self, relative: &str) -> std::io::Result<RegKey> {
                RegKey::predef(HKEY_CURRENT_USER)
                    .open_subkey(format!(r"{}\Classes\{relative}", self.subtree))
            }

            /// Enumerate the child key names of a `shell`-relative subkey.
            fn child_names(&self, relative: &str) -> Vec<String> {
                match self.open(relative) {
                    Ok(key) => key.enum_keys().filter_map(Result::ok).collect(),
                    Err(_) => Vec::new(),
                }
            }

            /// Default (`""`) string value of a `shell`-relative subkey.
            fn default_value(&self, relative: &str) -> String {
                self.open(relative)
                    .expect("subkey exists")
                    .get_value("")
                    .expect("default value present")
            }

            /// The `command` subkey's default value for a `shell`-relative entry.
            fn command_line(&self, entry_relative: &str) -> String {
                self.default_value(&format!(r"{entry_relative}\command"))
            }
        }

        impl Drop for TestScope {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.subtree);
            }
        }

        fn entry(
            id: &str,
            name: &str,
            visibility: ShellEntryVisibility,
            show_for: ShowForTargets,
        ) -> ShellEntry {
            ShellEntry {
                id: id.to_string(),
                name: name.to_string(),
                connection_id: None,
                visibility,
                show_for,
            }
        }

        fn all_targets() -> ShowForTargets {
            ShowForTargets {
                folders: true,
                files: true,
                folder_background: true,
            }
        }

        fn folders_only() -> ShowForTargets {
            ShowForTargets {
                folders: true,
                files: false,
                folder_background: false,
            }
        }

        #[test]
        fn install_writes_three_key_families_with_correct_command_lines() {
            let scope = TestScope::new("three-families");
            let entries = vec![entry(
                "open",
                "Open in termiHub",
                ShellEntryVisibility::Always,
                all_targets(),
            )];
            scope.registrar.install(&entries, EXE).unwrap();

            // Folder: HKCU\...\Directory\shell\termihub_open, uses %1.
            assert_eq!(
                scope.default_value(r"Directory\shell\termihub_open"),
                "Open in termiHub"
            );
            assert_eq!(
                scope.command_line(r"Directory\shell\termihub_open"),
                format!(r#""{EXE}" spawn --entry-id open --location "%1""#)
            );

            // File: HKCU\...\*\shell\termihub_open, uses %1.
            assert_eq!(
                scope.command_line(r"*\shell\termihub_open"),
                format!(r#""{EXE}" spawn --entry-id open --location "%1""#)
            );

            // Folder background: HKCU\...\Directory\Background\shell, uses %V.
            assert_eq!(
                scope.command_line(r"Directory\Background\shell\termihub_open"),
                format!(r#""{EXE}" spawn --entry-id open --location "%V""#)
            );

            // Icon points at the executable.
            let icon: String = scope
                .open(r"Directory\shell\termihub_open")
                .unwrap()
                .get_value("Icon")
                .unwrap();
            assert_eq!(icon, format!("{EXE},0"));
        }

        #[test]
        fn only_selected_target_families_are_written() {
            let scope = TestScope::new("selected-targets");
            let entries = vec![entry(
                "open",
                "Open in termiHub",
                ShellEntryVisibility::Always,
                folders_only(),
            )];
            scope.registrar.install(&entries, EXE).unwrap();

            assert!(scope.open(r"Directory\shell\termihub_open").is_ok());
            assert!(scope.open(r"*\shell\termihub_open").is_err());
            assert!(scope
                .open(r"Directory\Background\shell\termihub_open")
                .is_err());
        }

        #[test]
        fn extended_entry_carries_extended_value() {
            let scope = TestScope::new("extended");
            let entries = vec![entry(
                "picker",
                "Pick session…",
                ShellEntryVisibility::Extended,
                folders_only(),
            )];
            scope.registrar.install(&entries, EXE).unwrap();

            let key = scope.open(r"Directory\shell\termihub_picker").unwrap();
            let extended: String = key.get_value("Extended").unwrap();
            assert_eq!(extended, "");
        }

        #[test]
        fn always_entry_has_no_extended_value() {
            let scope = TestScope::new("always");
            let entries = vec![entry(
                "open",
                "Open in termiHub",
                ShellEntryVisibility::Always,
                folders_only(),
            )];
            scope.registrar.install(&entries, EXE).unwrap();

            let key = scope.open(r"Directory\shell\termihub_open").unwrap();
            assert!(key.get_value::<String, _>("Extended").is_err());
        }

        #[test]
        fn cascading_submenu_created_for_three_always_entries() {
            let scope = TestScope::new("cascade");
            let entries = vec![
                entry("a", "Entry A", ShellEntryVisibility::Always, folders_only()),
                entry("b", "Entry B", ShellEntryVisibility::Always, folders_only()),
                entry("c", "Entry C", ShellEntryVisibility::Always, folders_only()),
            ];
            scope.registrar.install(&entries, EXE).unwrap();

            // Under Directory\shell there is a single termiHubMenu parent, and
            // the individual entries are nested beneath it, not at top level.
            let top = scope.child_names(r"Directory\shell");
            assert!(top.iter().any(|n| n == "termiHubMenu"));
            assert!(!top.iter().any(|n| n.starts_with("termihub_")));

            let parent = scope.open(r"Directory\shell\termiHubMenu").unwrap();
            let mui: String = parent.get_value("MUIVerb").unwrap();
            assert_eq!(mui, "termiHub");
            let subcommands: String = parent.get_value("SubCommands").unwrap();
            assert_eq!(subcommands, "");

            let children = scope.child_names(r"Directory\shell\termiHubMenu\shell");
            assert_eq!(children.len(), 3);
            assert_eq!(
                scope.command_line(r"Directory\shell\termiHubMenu\shell\termihub_a"),
                format!(r#""{EXE}" spawn --entry-id a --location "%1""#)
            );
        }

        #[test]
        fn two_always_entries_stay_flat() {
            let scope = TestScope::new("flat");
            let entries = vec![
                entry("a", "Entry A", ShellEntryVisibility::Always, folders_only()),
                entry("b", "Entry B", ShellEntryVisibility::Always, folders_only()),
            ];
            scope.registrar.install(&entries, EXE).unwrap();

            let top = scope.child_names(r"Directory\shell");
            assert!(top.iter().any(|n| n == "termihub_a"));
            assert!(top.iter().any(|n| n == "termihub_b"));
            assert!(!top.iter().any(|n| n == "termiHubMenu"));
        }

        #[test]
        fn reinstall_is_idempotent() {
            let scope = TestScope::new("idempotent");
            let entries = vec![entry(
                "open",
                "Open in termiHub",
                ShellEntryVisibility::Always,
                folders_only(),
            )];
            scope.registrar.install(&entries, EXE).unwrap();
            scope.registrar.install(&entries, EXE).unwrap();

            let names = scope.child_names(r"Directory\shell");
            let ours: Vec<&String> = names.iter().filter(|n| n.starts_with("termihub")).collect();
            assert_eq!(ours.len(), 1);
        }

        #[test]
        fn reinstall_drops_removed_entries() {
            let scope = TestScope::new("drop-removed");
            let first = vec![
                entry("a", "Entry A", ShellEntryVisibility::Always, folders_only()),
                entry("b", "Entry B", ShellEntryVisibility::Always, folders_only()),
            ];
            scope.registrar.install(&first, EXE).unwrap();

            let second = vec![entry(
                "a",
                "Entry A",
                ShellEntryVisibility::Always,
                folders_only(),
            )];
            scope.registrar.install(&second, EXE).unwrap();

            let names = scope.child_names(r"Directory\shell");
            assert!(names.iter().any(|n| n == "termihub_a"));
            assert!(!names.iter().any(|n| n == "termihub_b"));
        }

        #[test]
        fn uninstall_removes_all_key_families_and_submenu() {
            let scope = TestScope::new("uninstall");
            let entries = vec![
                entry("a", "Entry A", ShellEntryVisibility::Always, all_targets()),
                entry("b", "Entry B", ShellEntryVisibility::Always, all_targets()),
                entry("c", "Entry C", ShellEntryVisibility::Always, all_targets()),
            ];
            scope.registrar.install(&entries, EXE).unwrap();
            scope.registrar.uninstall().unwrap();

            for root in [
                r"Directory\shell",
                r"Directory\Background\shell",
                r"*\shell",
            ] {
                let names = scope.child_names(root);
                assert!(
                    !names
                        .iter()
                        .any(|n| n.to_ascii_lowercase().starts_with("termihub")),
                    "root {root} still had termiHub keys: {names:?}"
                );
            }
        }

        #[test]
        fn uninstall_without_prior_install_is_ok() {
            let scope = TestScope::new("uninstall-empty");
            scope.registrar.uninstall().unwrap();
        }
    }
}
