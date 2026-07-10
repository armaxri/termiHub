//! Windows Explorer context-menu registry registration (#1368).
//!
//! Part of the Shell Context Menu & CLI Spawn Integration epic (#1363). Writes
//! and removes the user-level (`HKCU\Software\Classes\…`) registry keys that make
//! configured [`ShellEntry`]s appear as "Open in termiHub" entries in Windows
//! Explorer's right-click menus — for folders, folder backgrounds, and files.
//!
//! All keys live under `HKEY_CURRENT_USER`, so **no administrator rights** are
//! required. Registration is idempotent: install first clears any prior termiHub
//! keys, then rewrites them from the current entry list.
//!
//! Callers use the cross-platform [`register`] / [`unregister`] seam, which
//! records the registration facts into [`ShellIntegrationSettings`]. On
//! non-Windows platforms the underlying registry work returns a clear
//! "unsupported on this platform" error before any state changes, so the calling
//! Tauri commands and CLI subcommands behave predictably everywhere.

use crate::connection::shell_integration::{ShellEntry, ShellIntegrationSettings};
use anyhow::Context;

/// Message returned by the install / uninstall entry points on non-Windows
/// platforms, where Explorer registry registration does not apply.
#[cfg(not(windows))]
const UNSUPPORTED_MESSAGE: &str =
    "Windows Explorer context-menu registration is only supported on Windows";

/// Register the integration for `settings.entries`, recording the registration
/// facts (`registered` flag + executable path) back into `settings`.
///
/// Cross-platform entry point shared by the Tauri command and the pre-init CLI
/// subcommand. On success the caller persists the mutated `settings`. On an
/// unsupported platform the underlying `install` fails before any field is
/// touched, so `settings` is left unchanged.
pub fn register(settings: &mut ShellIntegrationSettings) -> anyhow::Result<()> {
    let exe = current_exe_path()?;
    install(&settings.entries, &exe)?;
    settings.registered = true;
    settings.registered_exe_path = Some(exe);
    Ok(())
}

/// Remove the integration and clear the recorded registration facts from
/// `settings`. Cross-platform counterpart to [`register`].
pub fn unregister(settings: &mut ShellIntegrationSettings) -> anyhow::Result<()> {
    uninstall()?;
    settings.registered = false;
    settings.registered_exe_path = None;
    Ok(())
}

/// Resolve the current executable's absolute path as a string.
fn current_exe_path() -> anyhow::Result<String> {
    Ok(std::env::current_exe()
        .context("resolve current executable path")?
        .to_string_lossy()
        .into_owned())
}

/// Register the given shell-integration entries as Explorer context-menu items.
///
/// Windows-only. Idempotent — an existing registration is replaced. `exe_path`
/// is the absolute path to the termiHub executable that the menu commands invoke.
/// Private: callers go through the cross-platform [`register`] seam.
#[cfg(windows)]
fn install(entries: &[ShellEntry], exe_path: &str) -> anyhow::Result<()> {
    imp::Registrar::system().install(entries, exe_path)
}

/// Remove every termiHub Explorer context-menu registration (Windows-only).
/// Private: callers go through the cross-platform [`unregister`] seam.
#[cfg(windows)]
fn uninstall() -> anyhow::Result<()> {
    imp::Registrar::system().uninstall()
}

/// Non-Windows stub: Explorer registry registration does not apply here.
#[cfg(not(windows))]
fn install(_entries: &[ShellEntry], _exe_path: &str) -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

/// Non-Windows stub: Explorer registry registration does not apply here.
#[cfg(not(windows))]
fn uninstall() -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::macos::{self, Registrar};
    use crate::connection::shell_integration::{ShellEntry, ShellEntryVisibility, ShowForTargets};
    use std::path::PathBuf;

    const EXE: &str = "/Applications/termiHub.app/Contents/MacOS/termiHub";

    /// A throwaway `Library/Services` directory that is deleted on drop, so a
    /// test never touches the user's real `~/Library/Services`.
    struct TempServices {
        dir: PathBuf,
    }

    impl TempServices {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "termihub-services-test-{}-{tag}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp services dir");
            Self { dir }
        }

        fn registrar(&self) -> Registrar {
            Registrar::for_test(self.dir.clone())
        }

        fn bundle(&self, dir_name: &str) -> PathBuf {
            self.dir.join(dir_name)
        }

        fn read(&self, relative: &str) -> String {
            std::fs::read_to_string(self.dir.join(relative))
                .unwrap_or_else(|e| panic!("read {relative}: {e}"))
        }
    }

    impl Drop for TempServices {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
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

    fn entry(id: &str, name: &str, show_for: ShowForTargets) -> ShellEntry {
        ShellEntry {
            id: id.to_string(),
            name: name.to_string(),
            connection_id: None,
            visibility: ShellEntryVisibility::Always,
            show_for,
        }
    }

    #[test]
    fn install_creates_one_workflow_bundle_per_entry() {
        let services = TempServices::new("per-entry");
        let entries = vec![
            entry("open", "Open in termiHub", all_targets()),
            entry("pick", "Pick session", folders_only()),
        ];
        services.registrar().install(&entries, EXE).unwrap();

        for name in ["Open in termiHub", "Pick session"] {
            let bundle = services.bundle(&format!("{name}.workflow"));
            assert!(
                bundle.join("Contents/document.wflow").is_file(),
                "missing document.wflow for {name}"
            );
            assert!(
                bundle.join("Contents/Info.plist").is_file(),
                "missing Info.plist for {name}"
            );
        }
    }

    #[test]
    fn document_wflow_carries_the_spawn_command_and_service_metadata() {
        let services = TempServices::new("wflow-command");
        let entries = vec![entry("open", "Open in termiHub", all_targets())];
        services.registrar().install(&entries, EXE).unwrap();

        let wflow = services.read("Open in termiHub.workflow/Contents/document.wflow");
        // The Run Shell Script action invokes the spawn subcommand with the
        // selected paths passed as arguments (&quot; is the XML-escaped quote).
        assert!(
            wflow.contains("spawn --entry-id open --location &quot;$@&quot;"),
            "wflow missing spawn command: {wflow}"
        );
        assert!(wflow.contains(EXE), "wflow missing exe path");
        // It must be a Finder services-menu workflow.
        assert!(wflow.contains("com.apple.Automator.servicesMenu"));
        assert!(wflow.contains("Run Shell Script"));
        assert!(wflow.starts_with("<?xml"));
    }

    #[test]
    fn info_plist_declares_nsservices_menu_item_and_owner_marker() {
        let services = TempServices::new("info-plist");
        let entries = vec![entry("open", "Open in termiHub", folders_only())];
        services.registrar().install(&entries, EXE).unwrap();

        let plist = services.read("Open in termiHub.workflow/Contents/Info.plist");
        assert!(plist.contains("<key>NSServices</key>"));
        assert!(plist.contains("<string>runWorkflowAsService</string>"));
        assert!(plist.contains("<string>Open in termiHub</string>"));
        assert!(plist.contains("<string>public.folder</string>"));
        // Owner marker lets uninstall recognise our bundles.
        assert!(plist.contains(macos::MARKER_KEY));
    }

    #[test]
    fn send_file_types_map_show_for_targets() {
        assert_eq!(
            macos::send_file_types(&all_targets()),
            vec!["public.folder", "public.data"]
        );
        assert_eq!(
            macos::send_file_types(&folders_only()),
            vec!["public.folder"]
        );
        assert_eq!(
            macos::send_file_types(&ShowForTargets {
                folders: false,
                files: true,
                folder_background: false,
            }),
            vec!["public.data"]
        );
    }

    #[test]
    fn xml_special_characters_in_name_are_escaped() {
        let services = TempServices::new("escaping");
        let entries = vec![entry("amp", "Open & Run", folders_only())];
        services.registrar().install(&entries, EXE).unwrap();

        let plist = services.read("Open & Run.workflow/Contents/Info.plist");
        assert!(plist.contains("<string>Open &amp; Run</string>"));
    }

    #[test]
    fn bundle_name_sanitizes_path_separators() {
        let services = TempServices::new("sanitize");
        let entries = vec![entry("slash", "Open / Here", folders_only())];
        services.registrar().install(&entries, EXE).unwrap();

        // The `/` is illegal in a filename and is replaced with `-`.
        assert!(services.bundle("Open - Here.workflow").is_dir());
    }

    #[test]
    fn install_is_idempotent() {
        let services = TempServices::new("idempotent");
        let entries = vec![entry("open", "Open in termiHub", folders_only())];
        services.registrar().install(&entries, EXE).unwrap();
        services.registrar().install(&entries, EXE).unwrap();

        let count = std::fs::read_dir(&services.dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("workflow"))
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn reinstall_drops_removed_entries() {
        let services = TempServices::new("drop-removed");
        let first = vec![
            entry("a", "Entry A", folders_only()),
            entry("b", "Entry B", folders_only()),
        ];
        services.registrar().install(&first, EXE).unwrap();

        let second = vec![entry("a", "Entry A", folders_only())];
        services.registrar().install(&second, EXE).unwrap();

        assert!(services.bundle("Entry A.workflow").is_dir());
        assert!(!services.bundle("Entry B.workflow").exists());
    }

    #[test]
    fn uninstall_removes_our_bundles() {
        let services = TempServices::new("uninstall");
        let entries = vec![
            entry("a", "Entry A", all_targets()),
            entry("b", "Entry B", all_targets()),
        ];
        services.registrar().install(&entries, EXE).unwrap();
        services.registrar().uninstall().unwrap();

        assert!(!services.bundle("Entry A.workflow").exists());
        assert!(!services.bundle("Entry B.workflow").exists());
    }

    #[test]
    fn uninstall_preserves_foreign_bundles() {
        let services = TempServices::new("foreign");
        // A pre-existing, non-termiHub Quick Action bundle.
        let foreign = services.bundle("Someone Else.workflow");
        std::fs::create_dir_all(foreign.join("Contents")).unwrap();
        std::fs::write(
            foreign.join("Contents/Info.plist"),
            "<plist><dict/></plist>",
        )
        .unwrap();

        let entries = vec![entry("a", "Entry A", folders_only())];
        services.registrar().install(&entries, EXE).unwrap();
        services.registrar().uninstall().unwrap();

        assert!(!services.bundle("Entry A.workflow").exists());
        assert!(foreign.is_dir(), "foreign bundle must survive uninstall");
    }

    #[test]
    fn uninstall_without_prior_install_is_ok() {
        let services = TempServices::new("uninstall-empty");
        // Remove the dir entirely so uninstall must tolerate a missing dir.
        std::fs::remove_dir_all(&services.dir).unwrap();
        services.registrar().uninstall().unwrap();
    }
}

#[cfg(windows)]
mod imp {
    use super::ShellEntry;
    use crate::connection::shell_integration::ShellEntryVisibility;
    use anyhow::{Context, Result};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    /// Root registry location under which all class definitions live.
    const SYSTEM_CLASSES_ROOT: &str = r"Software\Classes";
    /// Prefix for the per-entry registry key name (`termihub_<slug>`).
    const ENTRY_KEY_PREFIX: &str = "termihub_";
    /// Name of the cascading submenu parent key created at the threshold below.
    const SUBMENU_KEY: &str = "termiHubMenu";
    /// Display name (`MUIVerb`) of the cascading submenu parent.
    const SUBMENU_LABEL: &str = "termiHub";
    /// Number of `Always`-visible entries at or above which the entries are
    /// grouped under a single cascading [`SUBMENU_KEY`] submenu.
    const CASCADE_THRESHOLD: usize = 3;

    /// One of the three Explorer right-click surfaces termiHub registers under.
    #[derive(Clone, Copy)]
    enum Root {
        /// Right-click on a folder.
        Directory,
        /// Right-click on a folder's empty background.
        Background,
        /// Right-click on a file.
        AllFiles,
    }

    impl Root {
        /// Every root, in a stable order.
        const ALL: [Root; 3] = [Root::Directory, Root::Background, Root::AllFiles];

        /// Sub-path (relative to the class store) of this root's `shell` key.
        fn shell_subpath(self) -> &'static str {
            match self {
                Root::Directory => r"Directory\shell",
                Root::Background => r"Directory\Background\shell",
                Root::AllFiles => r"*\shell",
            }
        }

        /// Explorer command placeholder for the clicked path. Folder backgrounds
        /// expand `%V` (the open folder); folders and files expand `%1`.
        fn location_placeholder(self) -> &'static str {
            match self {
                Root::Background => "%V",
                Root::Directory | Root::AllFiles => "%1",
            }
        }

        /// Whether `entry` opted into this root via its `show_for` targets.
        fn applies_to(self, entry: &ShellEntry) -> bool {
            match self {
                Root::Directory => entry.show_for.folders,
                Root::Background => entry.show_for.folder_background,
                Root::AllFiles => entry.show_for.files,
            }
        }
    }

    /// Registry key name for an entry: `termihub_<slug>`, where the slug is the
    /// entry id reduced to lowercase ASCII alphanumerics (other characters →
    /// `_`) so it is always a valid single-segment key name.
    fn entry_key_name(entry: &ShellEntry) -> String {
        let slug: String = entry
            .id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '_'
                }
            })
            .collect();
        format!("{ENTRY_KEY_PREFIX}{slug}")
    }

    /// The `Icon` value pointing at the executable's first icon resource.
    fn icon_value(exe_path: &str) -> String {
        format!("{exe_path},0")
    }

    /// The `command` default value invoked when the entry is chosen.
    fn command_line(exe_path: &str, entry: &ShellEntry, placeholder: &str) -> String {
        format!(
            r#""{exe_path}" spawn --entry-id {id} --location "{placeholder}""#,
            id = entry.id,
        )
    }

    /// True for any registry key name termiHub owns (entry keys and the submenu
    /// parent), matched case-insensitively for robust removal.
    fn is_termihub_key(name: &str) -> bool {
        name.to_ascii_lowercase().starts_with("termihub")
    }

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

        /// Absolute registry path of a root's `shell` key under this class store.
        fn shell_path(&self, root: Root) -> String {
            format!(r"{}\{}", self.classes_root, root.shell_subpath())
        }

        /// Install the context-menu entries (idempotent).
        ///
        /// Any prior termiHub registration is cleared first, so calling this
        /// with the current entry list always converges to exactly that set.
        /// When at least [`CASCADE_THRESHOLD`] entries are `Always`-visible, the
        /// entries are grouped under a single cascading [`SUBMENU_KEY`] submenu.
        pub fn install(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            // Idempotency: start from a clean slate.
            self.uninstall()?;

            let cascade = always_count(entries) >= CASCADE_THRESHOLD;
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);

            for root in Root::ALL {
                let applicable: Vec<&ShellEntry> =
                    entries.iter().filter(|e| root.applies_to(e)).collect();
                if applicable.is_empty() {
                    continue;
                }

                let shell_path = self.shell_path(root);
                let (shell, _) = hkcu
                    .create_subkey(&shell_path)
                    .with_context(|| format!("create registry key {shell_path}"))?;

                let parent = if cascade {
                    write_submenu_parent(&shell, exe_path)
                        .context("write cascading submenu parent")?
                } else {
                    shell
                };

                for entry in applicable {
                    write_entry(&parent, entry, exe_path, root.location_placeholder())
                        .with_context(|| format!("write registry entry {}", entry.id))?;
                }
            }
            Ok(())
        }

        /// Remove every termiHub context-menu entry across all three roots,
        /// including the cascading submenu parent. Never fails when nothing is
        /// registered.
        pub fn uninstall(&self) -> Result<()> {
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            for root in Root::ALL {
                let shell_path = self.shell_path(root);
                let shell = match hkcu.open_subkey_with_flags(&shell_path, KEY_READ | KEY_WRITE) {
                    Ok(key) => key,
                    // Nothing registered under this root — nothing to remove.
                    Err(_) => continue,
                };
                let names: Vec<String> = shell.enum_keys().filter_map(Result::ok).collect();
                for name in names {
                    if is_termihub_key(&name) {
                        shell.delete_subkey_all(&name).with_context(|| {
                            format!(r"delete registry subtree {shell_path}\{name}")
                        })?;
                    }
                }
            }
            Ok(())
        }
    }

    /// Count of `Always`-visible entries — the cascade trigger.
    fn always_count(entries: &[ShellEntry]) -> usize {
        entries
            .iter()
            .filter(|e| e.visibility == ShellEntryVisibility::Always)
            .count()
    }

    /// Create the cascading submenu parent under `shell` and return the nested
    /// `shell` key its child entries are written into.
    ///
    /// An empty `SubCommands` value opts the parent into the modern subcommand
    /// model, where Explorer enumerates the children under `<parent>\shell`.
    fn write_submenu_parent(shell: &RegKey, exe_path: &str) -> Result<RegKey> {
        let (parent, _) = shell
            .create_subkey(SUBMENU_KEY)
            .context("create submenu parent key")?;
        parent
            .set_value("MUIVerb", &SUBMENU_LABEL.to_string())
            .context("set submenu label")?;
        parent
            .set_value("SubCommands", &String::new())
            .context("set submenu SubCommands")?;
        parent
            .set_value("Icon", &icon_value(exe_path))
            .context("set submenu Icon")?;
        let (parent_shell, _) = parent
            .create_subkey("shell")
            .context("create submenu shell key")?;
        Ok(parent_shell)
    }

    /// Write a single entry's key (display name, Icon, optional Extended) plus
    /// its `command` subkey under the given parent `shell` key.
    fn write_entry(
        parent_shell: &RegKey,
        entry: &ShellEntry,
        exe_path: &str,
        placeholder: &str,
    ) -> Result<()> {
        let (key, _) = parent_shell
            .create_subkey(entry_key_name(entry))
            .context("create entry key")?;
        key.set_value("", &entry.name)
            .context("set entry display name")?;
        key.set_value("Icon", &icon_value(exe_path))
            .context("set entry Icon")?;
        if entry.visibility == ShellEntryVisibility::Extended {
            // Presence (empty string) hides the entry behind Shift+right-click.
            key.set_value("Extended", &String::new())
                .context("set entry Extended flag")?;
        }
        let (command, _) = key
            .create_subkey("command")
            .context("create entry command subkey")?;
        command
            .set_value("", &command_line(exe_path, entry, placeholder))
            .context("set entry command line")?;
        Ok(())
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
