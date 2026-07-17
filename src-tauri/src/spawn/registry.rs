//! OS context-menu / Quick Action registration.
//!
//! Part of the Shell Context Menu & CLI Spawn Integration epic (#1363).
//!
//! * **Windows** (#1368): writes and removes the user-level
//!   (`HKCU\Software\Classes\…`) registry keys that make configured
//!   [`ShellEntry`]s appear as "Open in termiHub" entries in Explorer's
//!   right-click menus — for folders, folder backgrounds, and files. All keys
//!   live under `HKEY_CURRENT_USER`, so **no administrator rights** are required.
//! * **macOS** (#1369): writes and removes per-entry Automator Quick Action
//!   bundles under `~/Library/Services/<name>.workflow`, each carrying its own
//!   `NSServices` declaration so the entry surfaces under Finder's Quick Actions
//!   and the Services menu. User-level only.
//! * **Linux** (#1370): writes a universal XDG `.desktop` launcher under
//!   `~/.local/share/applications/` (registered for the `inode/directory` MIME
//!   type, refreshed via `update-desktop-database`) plus per-file-manager
//!   surfaces that are installed only when the manager is detected *and* enabled
//!   in [`LinuxFileManagerToggles`]: Nautilus scripts
//!   (`~/.local/share/nautilus/scripts/`, mode `0o755`), KDE service menus
//!   (`kservices5/ServiceMenus` for KDE 5, `kio/servicemenus` for KDE 6), and a
//!   Thunar custom action appended into the shared `~/.config/Thunar/uca.xml`.
//!   All user-level; no root required.
//!
//! Registration is idempotent on every platform: install first clears any prior
//! termiHub registration, then rewrites it from the current entry list. The
//! Thunar de-append preserves foreign actions already present in `uca.xml`.
//!
//! Callers use the cross-platform [`register`] / [`unregister`] seam, which
//! records the registration facts into [`ShellIntegrationSettings`]. On
//! platforms without an implementation the underlying work returns a clear
//! "unsupported on this platform" error before any state changes, so the calling
//! Tauri commands and CLI subcommands behave predictably everywhere.

use crate::connection::shell_integration::{
    DetectedFileManager, ShellEntry, ShellIntegrationSettings,
};
use crate::spawn::SpawnKind;
use anyhow::Context;
use std::path::Path;

/// Message returned by the install / uninstall entry points on platforms that
/// have no context-menu / Quick Action registration implementation.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
const UNSUPPORTED_MESSAGE: &str =
    "file-manager context-menu registration is not supported on this platform";

/// Register the integration for `settings.entries`, recording the registration
/// facts (`registered` flag + executable path) back into `settings`.
///
/// Cross-platform entry point shared by the Tauri command and the pre-init CLI
/// subcommand. On success the caller persists the mutated `settings`. On an
/// unsupported platform the underlying `install` fails before any field is
/// touched, so `settings` is left unchanged.
pub fn register(settings: &mut ShellIntegrationSettings) -> anyhow::Result<()> {
    let exe = current_exe_path()?;
    install(settings, &exe)?;
    settings.registered = true;
    settings.registered_exe_path = Some(exe);
    Ok(())
}

/// Detect the file managers installed on the host, for the status command.
///
/// * **Linux** probes the per-user file-manager directories and `$PATH`
///   binaries for Nautilus, KDE (Dolphin) and Thunar, annotating each detected
///   manager with the version reported by its `--version` output.
/// * **macOS** and **Windows** report their single always-present native
///   manager (Finder / File Explorer); neither exposes a queryable version, so
///   `version` is `None`.
/// * Other platforms return an empty list.
pub fn detect_file_managers() -> Vec<DetectedFileManager> {
    #[cfg(target_os = "linux")]
    {
        linux::Registrar::user()
            .map(|r| r.detect())
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        vec![native_manager("finder", "Finder")]
    }
    #[cfg(target_os = "windows")]
    {
        vec![native_manager("explorer", "File Explorer")]
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// A native, always-present OS file manager (macOS Finder / Windows File
/// Explorer). These have no user-queryable version string, so `version` is
/// `None`.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn native_manager(id: &str, name: &str) -> DetectedFileManager {
    DetectedFileManager {
        id: id.to_string(),
        name: name.to_string(),
        detected: true,
        version: None,
    }
}

/// Extract the first whitespace-delimited token that looks like a version
/// number (starts with an ASCII digit) from a `--version` output string,
/// keeping only its leading run of digits and dots (so a `45.0-beta` token
/// reduces to `45.0`). Returns `None` when no such token exists.
///
/// Pure and platform-independent so it is exhaustively unit-testable without
/// invoking any binary.
#[cfg(any(target_os = "linux", test))]
fn first_version_token(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        if !token.starts_with(|c: char| c.is_ascii_digit()) {
            return None;
        }
        let version: String = token
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let version = version.trim_end_matches('.');
        (!version.is_empty()).then(|| version.to_string())
    })
}

/// Parse `nautilus --version` output (e.g. `GNOME nautilus 43.2` → `43.2`).
#[cfg(any(target_os = "linux", test))]
fn parse_nautilus_version(output: &str) -> Option<String> {
    first_version_token(output)
}

/// Parse `dolphin --version` output (e.g. `dolphin 22.12.3` → `22.12.3`).
#[cfg(any(target_os = "linux", test))]
fn parse_dolphin_version(output: &str) -> Option<String> {
    first_version_token(output)
}

/// Parse `thunar --version` output (e.g. `Thunar 4.18.4` → `4.18.4`).
#[cfg(any(target_os = "linux", test))]
fn parse_thunar_version(output: &str) -> Option<String> {
    first_version_token(output)
}

#[cfg(test)]
mod version_parsing_tests {
    use super::{parse_dolphin_version, parse_nautilus_version, parse_thunar_version};

    #[test]
    fn nautilus_version_extracted() {
        // `nautilus --version` → "GNOME nautilus 43.2".
        assert_eq!(
            parse_nautilus_version("GNOME nautilus 43.2"),
            Some("43.2".to_string())
        );
        assert_eq!(
            parse_nautilus_version("GNOME nautilus 3.26.4"),
            Some("3.26.4".to_string())
        );
    }

    #[test]
    fn dolphin_version_extracted() {
        // `dolphin --version` → "dolphin 22.12.3".
        assert_eq!(
            parse_dolphin_version("dolphin 22.12.3"),
            Some("22.12.3".to_string())
        );
        assert_eq!(
            parse_dolphin_version("dolphin 24.08.1\n"),
            Some("24.08.1".to_string())
        );
    }

    #[test]
    fn thunar_version_extracted() {
        // `thunar --version` → "Thunar 4.18.4\nCopyright ...".
        assert_eq!(
            parse_thunar_version("Thunar 4.18.4\nCopyright (c) 2004-2023"),
            Some("4.18.4".to_string())
        );
        // A leading "xfce4" token must not be mistaken for the version.
        assert_eq!(
            parse_thunar_version("xfce4 Thunar 4.16.0"),
            Some("4.16.0".to_string())
        );
    }

    #[test]
    fn malformed_or_absent_output_yields_none() {
        assert_eq!(parse_nautilus_version(""), None);
        assert_eq!(parse_dolphin_version("no version here"), None);
        assert_eq!(parse_thunar_version("Thunar"), None);
    }

    #[test]
    fn trailing_prerelease_suffix_trimmed_to_numeric() {
        // A "45.0-beta" token is reduced to its leading numeric run.
        assert_eq!(
            parse_nautilus_version("GNOME nautilus 45.0-beta"),
            Some("45.0".to_string())
        );
    }
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

/// Register `settings.entries` as Explorer context-menu items.
///
/// Windows-only. Idempotent — an existing registration is replaced. `exe_path`
/// is the absolute path to the termiHub executable that the menu commands invoke.
/// Private: callers go through the cross-platform [`register`] seam.
#[cfg(windows)]
fn install(settings: &ShellIntegrationSettings, exe_path: &str) -> anyhow::Result<()> {
    imp::Registrar::system().install(&settings.entries, exe_path)
}

/// Remove every termiHub Explorer context-menu registration (Windows-only).
/// Private: callers go through the cross-platform [`unregister`] seam.
#[cfg(windows)]
fn uninstall() -> anyhow::Result<()> {
    imp::Registrar::system().uninstall()
}

/// Register `settings.entries` as macOS Finder Quick Action bundles under
/// `~/Library/Services`. Idempotent — an existing registration is replaced.
/// Private: callers go through the cross-platform [`register`] seam.
#[cfg(target_os = "macos")]
fn install(settings: &ShellIntegrationSettings, exe_path: &str) -> anyhow::Result<()> {
    macos::Registrar::user()?.install(&settings.entries, exe_path)
}

/// Remove every termiHub Quick Action bundle from `~/Library/Services`
/// (macOS-only). Private: callers go through the cross-platform [`unregister`]
/// seam.
#[cfg(target_os = "macos")]
fn uninstall() -> anyhow::Result<()> {
    macos::Registrar::user()?.uninstall()
}

/// Register `settings.entries` across the detected Linux file-manager surfaces
/// (XDG `.desktop`, plus Nautilus / KDE / Thunar when detected and enabled).
/// Idempotent — an existing registration is replaced. Private: callers go
/// through the cross-platform [`register`] seam.
#[cfg(target_os = "linux")]
fn install(settings: &ShellIntegrationSettings, exe_path: &str) -> anyhow::Result<()> {
    linux::Registrar::user()?.install(settings, exe_path)
}

/// Remove every termiHub Linux file-manager artifact (all four surfaces),
/// preserving foreign Thunar actions. Private: callers go through the
/// cross-platform [`unregister`] seam.
#[cfg(target_os = "linux")]
fn uninstall() -> anyhow::Result<()> {
    linux::Registrar::user()?.uninstall()
}

/// Stub for platforms without a context-menu registration implementation.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn install(_settings: &ShellIntegrationSettings, _exe_path: &str) -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

/// Stub for platforms without a context-menu registration implementation.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn uninstall() -> anyhow::Result<()> {
    anyhow::bail!(UNSUPPORTED_MESSAGE)
}

// ── Shared per-OS registration helpers ──────────────────────────────────────
//
// These four helpers are hoisted to file scope so the Windows, macOS and Linux
// `Registrar` arms below share one implementation each instead of carrying
// near-identical private copies. Each arm is `#[cfg]`-gated, so on any given
// platform some helpers have no non-test caller; `#[allow(dead_code)]` keeps
// that from tripping the `-D warnings` build. The `shared_helper_tests` module
// pins their exact output on every platform.

/// The termiHub spawn command line a surface invokes:
/// `"{exe_path}" spawn --entry-id {entry_id} --location {location}`, with
/// ` --kind {kind}` appended when the entry has a remembered spawn kind (#1561).
///
/// `location` is the *already-formatted* location token — the caller supplies
/// whatever quoting or placeholder its surface needs (macOS passes the quoted
/// `"$@"`, Windows the quoted `"%1"` / `"%V"`, Linux a bare `%f` or the quoted
/// `"$1"`).
///
/// `kind` carries the entry's saved target into the invocation, so a
/// context-menu click arrives already classified instead of as `auto` — which is
/// what lets a remembered container entry actually spawn a container rather than
/// falling through the presence-based inference to a local shell. [`SpawnKind::Auto`]
/// (no remembered choice) emits no flag at all, keeping the pre-#1561 command
/// line byte-for-byte.
#[allow(dead_code)]
fn spawn_command_line(exe_path: &str, entry_id: &str, kind: SpawnKind, location: &str) -> String {
    let kind_flag = match kind {
        SpawnKind::Auto => String::new(),
        kind => format!(" --kind {}", kind.to_wire()),
    };
    format!(r#""{exe_path}" spawn --entry-id {entry_id}{kind_flag} --location {location}"#)
}

/// Reduce an entry id to a single safe key/filename token: ASCII alphanumerics
/// are lowercased and every other character becomes `separator`. When `trim` is
/// set, leading and trailing `separator` runs are stripped (Linux slugs); when
/// unset the mapped string is kept verbatim (Windows registry key names). If the
/// result is empty, `empty_fallback` is returned — pass `""` to allow an empty
/// slug through unchanged.
#[allow(dead_code)]
fn id_slug(id: &str, separator: char, trim: bool, empty_fallback: &str) -> String {
    let mapped: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                separator
            }
        })
        .collect();
    let slug = if trim {
        mapped.trim_matches(separator)
    } else {
        mapped.as_str()
    };
    if slug.is_empty() {
        empty_fallback.to_string()
    } else {
        slug.to_string()
    }
}

/// Sanitize a display name into a filesystem-safe base: every character in
/// `replace` becomes `-`, then surrounding whitespace is trimmed. The result may
/// be empty (e.g. an all-whitespace name), in which case the caller supplies its
/// own fallback and any suffix.
#[allow(dead_code)]
fn sanitize_display_name(name: &str, replace: &[char]) -> String {
    name.chars()
        .map(|c| if replace.contains(&c) { '-' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// True when the file at `path` can be read and contains `marker`. A missing or
/// unreadable file yields `false` (it is simply "not ours").
#[allow(dead_code)]
fn file_contains_marker(path: &Path, marker: &str) -> bool {
    std::fs::read_to_string(path)
        .map(|contents| contents.contains(marker))
        .unwrap_or(false)
}

/// Unit tests pinning the exact behavior of the file-scope helpers shared by
/// all three OS `Registrar`s. These run on every platform (they touch none of
/// the `#[cfg]`-gated OS arms), so the byte-for-byte output each OS arm relies
/// on is verified even where that arm is compiled out.
#[cfg(test)]
mod shared_helper_tests {
    use super::*;

    #[test]
    fn spawn_command_line_formats_exe_id_and_location_token() {
        // Linux desktop / KDE / Thunar: bare `%f` placeholder, no quoting.
        assert_eq!(
            spawn_command_line("/opt/termihub/termiHub", "open", SpawnKind::Auto, "%f"),
            r#""/opt/termihub/termiHub" spawn --entry-id open --location %f"#
        );
        // macOS: the already-quoted `"$@"` token is passed through verbatim.
        assert_eq!(
            spawn_command_line("/Applications/termiHub", "open", SpawnKind::Auto, r#""$@""#),
            r#""/Applications/termiHub" spawn --entry-id open --location "$@""#
        );
        // Windows: the caller pre-quotes the `%1` / `%V` placeholder.
        assert_eq!(
            spawn_command_line(r"C:\termiHub.exe", "open", SpawnKind::Auto, "\"%1\""),
            r#""C:\termiHub.exe" spawn --entry-id open --location "%1""#
        );
    }

    /// A remembered entry (#1561) carries its kind into the invocation, so the
    /// click arrives already classified instead of as `auto`. Without this a
    /// remembered container entry falls through the presence-based inference and
    /// opens a local shell — the bug #1561 fixes.
    #[test]
    fn spawn_command_line_emits_a_remembered_kind() {
        assert_eq!(
            spawn_command_line("/opt/termihub/termiHub", "open", SpawnKind::Container, "%f"),
            r#""/opt/termihub/termiHub" spawn --entry-id open --kind container --location %f"#
        );
        assert_eq!(
            spawn_command_line("/opt/termihub/termiHub", "open", SpawnKind::Wsl, "%f"),
            r#""/opt/termihub/termiHub" spawn --entry-id open --kind wsl --location %f"#
        );
        assert_eq!(
            spawn_command_line("/opt/termihub/termiHub", "open", SpawnKind::Local, "%f"),
            r#""/opt/termihub/termiHub" spawn --entry-id open --kind local --location %f"#
        );
    }

    /// The emitted `--kind` token must be one the CLI parser actually accepts —
    /// otherwise registration writes a command line the app silently ignores.
    #[test]
    fn every_emitted_kind_round_trips_through_the_cli_parser() {
        for kind in [
            SpawnKind::Container,
            SpawnKind::Local,
            SpawnKind::Wsl,
            SpawnKind::Ssh,
            SpawnKind::Auto,
        ] {
            assert_eq!(
                SpawnKind::from_wire(kind.to_wire()),
                Some(kind),
                "{kind:?} does not round-trip through the wire token"
            );
        }
    }

    #[test]
    fn id_slug_windows_style_uses_underscore_without_trim_or_fallback() {
        // Windows `entry_key_name`: non-alnum → `_`, lowercased, no trimming,
        // and an all-non-alnum / empty id keeps an empty slug.
        assert_eq!(id_slug("Open.Session", '_', false, ""), "open_session");
        assert_eq!(id_slug(".git", '_', false, ""), "_git");
        assert_eq!(id_slug("a b", '_', false, ""), "a_b");
        assert_eq!(id_slug("", '_', false, ""), "");
        assert_eq!(id_slug("...", '_', false, ""), "___");
    }

    #[test]
    fn id_slug_linux_style_uses_hyphen_with_trim_and_fallback() {
        // Linux `slug`: non-alnum → `-`, lowercased, trimmed, empty → `entry`.
        assert_eq!(id_slug("Open.Session", '-', true, "entry"), "open-session");
        assert_eq!(id_slug("-a-", '-', true, "entry"), "a");
        assert_eq!(id_slug("...", '-', true, "entry"), "entry");
        assert_eq!(id_slug("", '-', true, "entry"), "entry");
    }

    #[test]
    fn sanitize_display_name_replaces_configured_chars_and_trims() {
        // macOS `bundle_dir_name` set includes the colon; Linux
        // `nautilus_script_name` set does not.
        assert_eq!(
            sanitize_display_name("Open / Here", &['/', '\\', ':']),
            "Open - Here"
        );
        assert_eq!(sanitize_display_name("a:b", &['/', '\\', ':']), "a-b");
        assert_eq!(sanitize_display_name("a:b", &['/', '\\']), "a:b");
        // Surrounding whitespace is trimmed; an all-whitespace name is empty so
        // the caller can substitute its own fallback.
        assert_eq!(sanitize_display_name("  Name  ", &['/', '\\']), "Name");
        assert_eq!(sanitize_display_name("   ", &['/', '\\']), "");
    }

    #[test]
    fn file_contains_marker_detects_marker_and_tolerates_missing_file() {
        let dir = std::env::temp_dir().join(format!("termihub-marker-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp marker dir");

        let present = dir.join("present.txt");
        std::fs::write(&present, "first line\nMARKER-XYZ\nlast line\n").expect("write present");
        let absent = dir.join("absent.txt");
        std::fs::write(&absent, "nothing to see here\n").expect("write absent");

        assert!(file_contains_marker(&present, "MARKER-XYZ"));
        assert!(!file_contains_marker(&absent, "MARKER-XYZ"));
        // A missing/unreadable file is simply "not ours".
        assert!(!file_contains_marker(
            &dir.join("missing.txt"),
            "MARKER-XYZ"
        ));

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// macOS Finder Quick Action / Services registration (#1369).
///
/// Each configured [`ShellEntry`] is written as a self-contained Automator
/// "Run Shell Script" workflow bundle under `~/Library/Services/<name>.workflow`.
/// The bundle's `document.wflow` runs `termiHub spawn --entry-id <id> --location
/// "$@"` with the selected paths passed as arguments; its `Info.plist` declares
/// an `NSServices` entry so Finder surfaces it under both Quick Actions and the
/// Services menu. Every generated `Info.plist` carries the [`MARKER_KEY`] so
/// uninstall removes only termiHub-owned bundles and never touches foreign ones.
#[cfg(target_os = "macos")]
mod macos {
    use super::{file_contains_marker, sanitize_display_name, spawn_command_line, ShellEntry};
    use crate::connection::shell_integration::ShowForTargets;
    use anyhow::{Context, Result};
    use std::path::{Path, PathBuf};

    /// Custom `Info.plist` key stamped into every generated bundle so uninstall
    /// can distinguish termiHub bundles from unrelated Quick Actions.
    const MARKER_KEY: &str = "TermiHubShellIntegration";

    /// Writes and removes the per-entry Quick Action bundles under a
    /// `Library/Services` directory.
    ///
    /// The `services_dir` is injectable so tests target a throwaway directory
    /// instead of the user's real `~/Library/Services`.
    pub struct Registrar {
        services_dir: PathBuf,
    }

    impl Registrar {
        /// Registrar targeting the real per-user `~/Library/Services`.
        pub fn user() -> Result<Self> {
            let services_dir = dirs::home_dir()
                .context("resolve home directory for macOS Services registration")?
                .join("Library/Services");
            Ok(Self { services_dir })
        }

        /// Registrar targeting a throwaway directory so a test never touches the
        /// user's real Quick Actions.
        #[cfg(test)]
        pub fn for_test(services_dir: PathBuf) -> Self {
            Self { services_dir }
        }

        /// Install a Quick Action bundle per entry (idempotent).
        ///
        /// Any prior termiHub registration is cleared first, so calling this with
        /// the current entry list always converges to exactly that set.
        pub fn install(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            // Idempotency: start from a clean slate.
            self.uninstall()?;
            if entries.is_empty() {
                return Ok(());
            }
            std::fs::create_dir_all(&self.services_dir)
                .with_context(|| format!("create services dir {}", self.services_dir.display()))?;
            for entry in entries {
                self.write_bundle(entry, exe_path)
                    .with_context(|| format!("write workflow bundle for entry {}", entry.id))?;
            }
            Ok(())
        }

        /// Remove every termiHub-owned Quick Action bundle. Foreign bundles (no
        /// [`MARKER_KEY`]) are left untouched. Never fails when nothing is
        /// registered or the services directory does not exist.
        pub fn uninstall(&self) -> Result<()> {
            if !self.services_dir.exists() {
                return Ok(());
            }
            for dir_entry in std::fs::read_dir(&self.services_dir)
                .with_context(|| format!("read services dir {}", self.services_dir.display()))?
            {
                let path = dir_entry
                    .with_context(|| {
                        format!("enumerate services dir {}", self.services_dir.display())
                    })?
                    .path();
                if is_workflow_bundle(&path) && bundle_is_ours(&path) {
                    std::fs::remove_dir_all(&path)
                        .with_context(|| format!("remove workflow bundle {}", path.display()))?;
                }
            }
            Ok(())
        }

        /// Write one entry's `<name>.workflow` bundle (`Contents/document.wflow`
        /// + `Contents/Info.plist`).
        fn write_bundle(&self, entry: &ShellEntry, exe_path: &str) -> Result<()> {
            let contents = self
                .services_dir
                .join(bundle_dir_name(entry))
                .join("Contents");
            std::fs::create_dir_all(&contents)
                .with_context(|| format!("create bundle contents {}", contents.display()))?;
            std::fs::write(
                contents.join("document.wflow"),
                workflow_xml(entry, exe_path),
            )
            .context("write document.wflow")?;
            std::fs::write(contents.join("Info.plist"), info_plist_xml(entry))
                .context("write bundle Info.plist")?;
            Ok(())
        }
    }

    /// True when `path` is a `*.workflow` bundle directory.
    fn is_workflow_bundle(path: &Path) -> bool {
        path.is_dir() && path.extension().and_then(|e| e.to_str()) == Some("workflow")
    }

    /// True when the bundle's `Info.plist` carries the termiHub owner marker.
    fn bundle_is_ours(bundle: &Path) -> bool {
        file_contains_marker(&bundle.join("Contents/Info.plist"), MARKER_KEY)
    }

    /// Filesystem-safe `<name>.workflow` directory name for an entry.
    ///
    /// Path separators (`/`, `\`) and the colon (`:`, shown as `/` in Finder)
    /// are replaced with `-`; an entry whose name reduces to empty falls back to
    /// its stable id.
    fn bundle_dir_name(entry: &ShellEntry) -> String {
        let base = sanitize_display_name(&entry.name, &['/', '\\', ':']);
        let base = if base.is_empty() {
            entry.id.clone()
        } else {
            base
        };
        format!("{base}.workflow")
    }

    /// The Uniform Type Identifiers a bundle accepts, derived from the entry's
    /// `show_for` targets. Folders (and folder-background) map to `public.folder`;
    /// files map to `public.data`. An entry with neither falls back to the
    /// catch-all `public.item` so it still surfaces somewhere.
    fn send_file_types(show_for: &ShowForTargets) -> Vec<&'static str> {
        let mut types = Vec::new();
        if show_for.folders || show_for.folder_background {
            types.push("public.folder");
        }
        if show_for.files {
            types.push("public.data");
        }
        if types.is_empty() {
            types.push("public.item");
        }
        types
    }

    /// The shell script the Quick Action runs: the spawn subcommand with the
    /// selected paths passed as positional arguments (the quoted `"$@"` token).
    fn shell_command(entry: &ShellEntry, exe_path: &str) -> String {
        spawn_command_line(exe_path, &entry.id, entry.spawn_kind, r#""$@""#)
    }

    /// Escape the five XML predefined entities so arbitrary names / paths embed
    /// safely into the plist templates.
    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }

    /// Render the bundle's `Info.plist`: an `NSServices` declaration plus the
    /// termiHub owner marker.
    fn info_plist_xml(entry: &ShellEntry) -> String {
        let name = xml_escape(&entry.name);
        let types = send_file_types(&entry.show_for)
            .iter()
            .map(|t| format!("\t\t\t\t<string>{t}</string>"))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>{name}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSSendFileTypes</key>
			<array>
{types}
			</array>
		</dict>
	</array>
	<key>{MARKER_KEY}</key>
	<true/>
</dict>
</plist>
"#
        )
    }

    /// Render the Automator `document.wflow` for the entry: a single "Run Shell
    /// Script" action wired as a Finder services-menu workflow, receiving the
    /// selected file-system objects as arguments.
    fn workflow_xml(entry: &ShellEntry, exe_path: &str) -> String {
        let command = xml_escape(&shell_command(entry, exe_path));
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>521</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>{command}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/zsh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>4F1C9A20-1369-4A11-9C01-000000000001</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>4F1C9A20-1369-4A11-9C01-000000000002</string>
				<key>UUID</key>
				<string>4F1C9A20-1369-4A11-9C01-000000000003</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>isViewVisible</key>
				<integer>1</integer>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<integer>0</integer>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
"#
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::connection::shell_integration::{ShellEntryVisibility, ShowForTargets};
        use crate::spawn::SpawnKind;
        use std::path::PathBuf;
        use termihub_core::config::ContainerRuntime;

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
                container_image: None,
                container_mount: None,
                spawn_kind: SpawnKind::Auto,
                shell: None,
                container_runtime: ContainerRuntime::Auto,
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
            assert!(plist.contains(MARKER_KEY));
        }

        #[test]
        fn send_file_types_map_show_for_targets() {
            assert_eq!(
                send_file_types(&all_targets()),
                vec!["public.folder", "public.data"]
            );
            assert_eq!(send_file_types(&folders_only()), vec!["public.folder"]);
            assert_eq!(
                send_file_types(&ShowForTargets {
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
}

#[cfg(windows)]
mod imp {
    use super::{id_slug, spawn_command_line, ShellEntry};
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
    /// `_`) so it is always a valid single-segment key name. No trimming or
    /// empty fallback: the prefix always keeps the key non-empty.
    fn entry_key_name(entry: &ShellEntry) -> String {
        format!("{ENTRY_KEY_PREFIX}{}", id_slug(&entry.id, '_', false, ""))
    }

    /// The `Icon` value pointing at the executable's first icon resource.
    fn icon_value(exe_path: &str) -> String {
        format!("{exe_path},0")
    }

    /// The `command` default value invoked when the entry is chosen. The
    /// Explorer `placeholder` (`%1` / `%V`) is wrapped in quotes for the command
    /// line.
    fn command_line(exe_path: &str, entry: &ShellEntry, placeholder: &str) -> String {
        spawn_command_line(
            exe_path,
            &entry.id,
            entry.spawn_kind,
            &format!("\"{placeholder}\""),
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
                container_image: None,
                container_mount: None,
                spawn_kind: SpawnKind::Auto,
                shell: None,
                container_runtime: ContainerRuntime::Auto,
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

/// Linux file-manager registration (#1370).
///
/// Writes a universal XDG `.desktop` launcher plus per-file-manager surfaces
/// (Nautilus scripts, KDE service menus, a Thunar custom action) that are only
/// installed when the manager is both **detected** on the host and **enabled**
/// in [`LinuxFileManagerToggles`]. Every artifact carries a termiHub owner
/// marker so uninstall removes only our files and, for the shared Thunar
/// `uca.xml`, preserves any foreign actions.
#[cfg(target_os = "linux")]
mod linux {
    use super::{
        file_contains_marker, id_slug, sanitize_display_name, spawn_command_line,
        DetectedFileManager, ShellEntry, ShellIntegrationSettings,
    };
    use anyhow::{Context, Result};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    /// Filename prefix for the `.desktop` files termiHub owns (XDG + KDE).
    const DESKTOP_PREFIX: &str = "termihub-";
    /// Marker line stamped into every `.desktop` file so uninstall removes only
    /// termiHub-owned files and never foreign ones.
    const DESKTOP_MARKER: &str = "X-TermiHub-Managed=true";
    /// Marker comment stamped into every Nautilus script. Nautilus script files
    /// are named after the display name (no prefix), so ownership is detected
    /// from the file contents.
    const NAUTILUS_MARKER: &str =
        "# termiHub shell integration (managed) — safe to remove via termiHub";
    /// `unique-id` prefix identifying termiHub's Thunar actions inside the shared
    /// `uca.xml`; used to de-append ours while preserving foreign actions.
    const THUNAR_ID_PREFIX: &str = "termihub-";
    /// Icon name referenced by every generated launcher/action.
    const ICON: &str = "termihub";

    /// Best-effort callback that refreshes the desktop MIME database after the
    /// XDG launchers change. Injected so tests can assert it ran without
    /// spawning the real `update-desktop-database` binary.
    type DesktopDbHook = Arc<dyn Fn(&Path) + Send + Sync>;

    /// Run `<binary> --version` and return its version output, preferring
    /// stdout but falling back to stderr (some tools print their banner there).
    /// Best-effort: a missing or failing binary yields `None`.
    fn query_version(binary: &str) -> Option<String> {
        let output = std::process::Command::new(binary)
            .arg("--version")
            .output()
            .ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.trim().is_empty() {
            return Some(stdout.into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        (!stderr.trim().is_empty()).then(|| stderr.into_owned())
    }

    /// Spawn `update-desktop-database <apps_dir>`, ignoring any failure (the
    /// tool is absent on minimal systems and the registration still works).
    fn run_update_desktop_database(apps_dir: &Path) {
        let _ = std::process::Command::new("update-desktop-database")
            .arg(apps_dir)
            .status();
    }

    /// Writes and removes the Linux file-manager artifacts under a set of XDG
    /// base directories.
    ///
    /// `data_local` (`~/.local/share`) and `config` (`~/.config`) are injectable
    /// so tests target throwaway directories instead of the user's real ones.
    pub struct Registrar {
        data_local: PathBuf,
        config: PathBuf,
        /// Whether detection may consult `$PATH` for file-manager binaries.
        /// Disabled in tests so detection depends only on the injected dirs.
        probe_path: bool,
        on_desktop_db_update: DesktopDbHook,
    }

    impl Registrar {
        /// Registrar targeting the real per-user XDG directories.
        pub fn user() -> Result<Self> {
            let data_local =
                dirs::data_local_dir().context("resolve XDG data dir (~/.local/share)")?;
            let config = dirs::config_dir().context("resolve XDG config dir (~/.config)")?;
            Ok(Self {
                data_local,
                config,
                probe_path: true,
                on_desktop_db_update: Arc::new(run_update_desktop_database),
            })
        }

        /// Registrar targeting throwaway directories so a test never touches the
        /// user's real file-manager configuration. Detection is limited to the
        /// injected dirs (no `$PATH` probing) for determinism.
        #[cfg(test)]
        pub fn for_test(data_local: PathBuf, config: PathBuf, hook: DesktopDbHook) -> Self {
            Self {
                data_local,
                config,
                probe_path: false,
                on_desktop_db_update: hook,
            }
        }

        // ── Directory layout ────────────────────────────────────────────

        fn applications_dir(&self) -> PathBuf {
            self.data_local.join("applications")
        }
        fn nautilus_scripts_dir(&self) -> PathBuf {
            self.data_local.join("nautilus/scripts")
        }
        fn kde5_dir(&self) -> PathBuf {
            self.data_local.join("kservices5/ServiceMenus")
        }
        fn kde6_dir(&self) -> PathBuf {
            self.data_local.join("kio/servicemenus")
        }
        fn thunar_dir(&self) -> PathBuf {
            self.config.join("Thunar")
        }
        fn thunar_uca(&self) -> PathBuf {
            self.thunar_dir().join("uca.xml")
        }

        // ── Detection ───────────────────────────────────────────────────

        fn has_binary(&self, name: &str) -> bool {
            self.probe_path && which::which(name).is_ok()
        }
        fn nautilus_detected(&self) -> bool {
            self.has_binary("nautilus")
                || self.nautilus_scripts_dir().exists()
                || self.data_local.join("nautilus").exists()
        }
        fn kde_detected(&self) -> bool {
            self.has_binary("dolphin") || self.kde5_dir().exists() || self.kde6_dir().exists()
        }
        fn thunar_detected(&self) -> bool {
            self.has_binary("thunar") || self.thunar_dir().exists()
        }

        /// Report the file managers detected on this host for the status command.
        ///
        /// A detected manager is annotated with the version parsed from its
        /// `--version` output. Version probing only runs when `$PATH` probing is
        /// enabled (i.e. not in tests), so directory-only detection never shells
        /// out.
        pub fn detect(&self) -> Vec<DetectedFileManager> {
            vec![
                self.detected_manager(
                    "nautilus",
                    "Nautilus",
                    "nautilus",
                    self.nautilus_detected(),
                    super::parse_nautilus_version,
                ),
                self.detected_manager(
                    "kde",
                    "Dolphin",
                    "dolphin",
                    self.kde_detected(),
                    super::parse_dolphin_version,
                ),
                self.detected_manager(
                    "thunar",
                    "Thunar",
                    "thunar",
                    self.thunar_detected(),
                    super::parse_thunar_version,
                ),
            ]
        }

        /// Build a [`DetectedFileManager`], querying `binary --version` and
        /// parsing it with `parse` when the manager is detected and `$PATH`
        /// probing is enabled. Version detection is best-effort: a missing or
        /// unparseable version simply yields `None`.
        fn detected_manager(
            &self,
            id: &str,
            name: &str,
            binary: &str,
            detected: bool,
            parse: fn(&str) -> Option<String>,
        ) -> DetectedFileManager {
            let version = if detected && self.probe_path {
                query_version(binary).as_deref().and_then(parse)
            } else {
                None
            };
            DetectedFileManager {
                id: id.to_string(),
                name: name.to_string(),
                detected,
                version,
            }
        }

        // ── Install / uninstall ─────────────────────────────────────────

        /// Install the enabled + detected surfaces (idempotent — a prior
        /// registration is cleared first).
        pub fn install(&self, settings: &ShellIntegrationSettings, exe_path: &str) -> Result<()> {
            // Idempotency: start from a clean slate (without refreshing the
            // desktop database yet — a single refresh happens at the end).
            self.remove_all()?;
            let entries = &settings.entries;
            if !entries.is_empty() {
                self.install_xdg(entries, exe_path)?;
                let toggles = settings.linux_file_managers;
                if toggles.nautilus && self.nautilus_detected() {
                    self.install_nautilus(entries, exe_path)?;
                }
                if toggles.kde && self.kde_detected() {
                    self.install_kde(entries, exe_path)?;
                }
                if toggles.thunar && self.thunar_detected() {
                    self.install_thunar(entries, exe_path)?;
                }
            }
            self.refresh_desktop_db();
            Ok(())
        }

        /// Remove every termiHub artifact across all four surfaces. Foreign
        /// files and foreign Thunar actions are left untouched. Never fails when
        /// nothing is registered.
        pub fn uninstall(&self) -> Result<()> {
            self.remove_all()?;
            self.refresh_desktop_db();
            Ok(())
        }

        /// Remove all four termiHub surfaces without refreshing the desktop
        /// database. Shared by [`install`](Self::install) (clean slate) and
        /// [`uninstall`](Self::uninstall).
        fn remove_all(&self) -> Result<()> {
            self.remove_xdg()?;
            self.remove_nautilus()?;
            self.remove_kde()?;
            self.remove_thunar()?;
            Ok(())
        }

        /// Best-effort refresh of the desktop MIME database, once per public
        /// operation. Skipped when the applications dir does not exist (nothing
        /// to index).
        fn refresh_desktop_db(&self) {
            let apps = self.applications_dir();
            if apps.exists() {
                (self.on_desktop_db_update)(&apps);
            }
        }

        // ── XDG .desktop (universal "Open With") ────────────────────────

        fn install_xdg(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            let dir_entries: Vec<&ShellEntry> = entries
                .iter()
                .filter(|e| e.show_for.folders || e.show_for.folder_background)
                .collect();
            if dir_entries.is_empty() {
                return Ok(());
            }
            let apps = self.applications_dir();
            std::fs::create_dir_all(&apps)
                .with_context(|| format!("create applications dir {}", apps.display()))?;
            for entry in &dir_entries {
                let path = apps.join(format!("{DESKTOP_PREFIX}{}.desktop", slug(entry)));
                std::fs::write(&path, xdg_desktop_file(entry, exe_path))
                    .with_context(|| format!("write XDG desktop file {}", path.display()))?;
            }
            Ok(())
        }

        fn remove_xdg(&self) -> Result<()> {
            remove_managed_files(
                &self.applications_dir(),
                Some(DESKTOP_PREFIX),
                DESKTOP_MARKER,
            )
        }

        // ── Nautilus scripts (GNOME) ────────────────────────────────────

        fn install_nautilus(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            let dir = self.nautilus_scripts_dir();
            std::fs::create_dir_all(&dir)
                .with_context(|| format!("create nautilus scripts dir {}", dir.display()))?;
            for entry in entries {
                let path = dir.join(nautilus_script_name(entry));
                std::fs::write(&path, nautilus_script(entry, exe_path))
                    .with_context(|| format!("write nautilus script {}", path.display()))?;
                set_executable(&path)?;
            }
            Ok(())
        }

        fn remove_nautilus(&self) -> Result<()> {
            remove_managed_files(&self.nautilus_scripts_dir(), None, NAUTILUS_MARKER)
        }

        // ── KDE service menus (Dolphin) ─────────────────────────────────

        fn install_kde(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            // The service menu targets the `inode/directory` MIME type, so only
            // directory-applicable entries get one (consistent with the XDG
            // launcher).
            let dir_entries: Vec<&ShellEntry> = entries
                .iter()
                .filter(|e| e.show_for.folders || e.show_for.folder_background)
                .collect();
            if dir_entries.is_empty() {
                return Ok(());
            }
            // Write into whichever service-menu dirs already exist (KDE 5 and/or
            // KDE 6). If detection succeeded via the binary but no dir exists
            // yet, default to the modern KDE 6 location.
            let mut targets: Vec<PathBuf> = Vec::new();
            if self.kde5_dir().exists() {
                targets.push(self.kde5_dir());
            }
            if self.kde6_dir().exists() {
                targets.push(self.kde6_dir());
            }
            if targets.is_empty() {
                targets.push(self.kde6_dir());
            }
            for dir in targets {
                std::fs::create_dir_all(&dir)
                    .with_context(|| format!("create KDE service-menu dir {}", dir.display()))?;
                for entry in &dir_entries {
                    let path = dir.join(format!("{DESKTOP_PREFIX}{}.desktop", slug(entry)));
                    std::fs::write(&path, kde_service_menu(entry, exe_path))
                        .with_context(|| format!("write KDE service menu {}", path.display()))?;
                }
            }
            Ok(())
        }

        fn remove_kde(&self) -> Result<()> {
            for dir in [self.kde5_dir(), self.kde6_dir()] {
                remove_managed_files(&dir, Some(DESKTOP_PREFIX), DESKTOP_MARKER)?;
            }
            Ok(())
        }

        // ── Thunar custom action (XFCE) ─────────────────────────────────

        fn install_thunar(&self, entries: &[ShellEntry], exe_path: &str) -> Result<()> {
            let uca = self.thunar_uca();
            std::fs::create_dir_all(self.thunar_dir()).with_context(|| {
                format!("create Thunar config dir {}", self.thunar_dir().display())
            })?;
            let existing = std::fs::read_to_string(&uca).ok();
            let ours: Vec<thunar::Action> = entries
                .iter()
                .map(|entry| thunar::Action {
                    name: entry.name.clone(),
                    unique_id: format!("{THUNAR_ID_PREFIX}{}", slug(entry)),
                    command: spawn_command_line(exe_path, &entry.id, entry.spawn_kind, "%f"),
                    directories: entry.show_for.folders || entry.show_for.folder_background,
                    other_files: entry.show_for.files,
                })
                .collect();
            let xml = thunar::rewrite(existing.as_deref(), &ours, THUNAR_ID_PREFIX)
                .context("rebuild Thunar uca.xml")?;
            std::fs::write(&uca, xml)
                .with_context(|| format!("write Thunar uca.xml {}", uca.display()))?;
            Ok(())
        }

        fn remove_thunar(&self) -> Result<()> {
            let uca = self.thunar_uca();
            let Ok(existing) = std::fs::read_to_string(&uca) else {
                return Ok(());
            };
            let xml = thunar::rewrite(Some(&existing), &[], THUNAR_ID_PREFIX)
                .context("strip termiHub actions from Thunar uca.xml")?;
            std::fs::write(&uca, xml)
                .with_context(|| format!("write Thunar uca.xml {}", uca.display()))?;
            Ok(())
        }
    }

    /// Remove files in `dir` that termiHub owns: matching `name_prefix` (when
    /// given) and containing `content_marker`. Tolerates a missing directory.
    fn remove_managed_files(
        dir: &Path,
        name_prefix: Option<&str>,
        content_marker: &str,
    ) -> Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        for dir_entry in
            std::fs::read_dir(dir).with_context(|| format!("read dir {}", dir.display()))?
        {
            let path = dir_entry
                .with_context(|| format!("enumerate dir {}", dir.display()))?
                .path();
            if !path.is_file() {
                continue;
            }
            if let Some(prefix) = name_prefix {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with(prefix) {
                    continue;
                }
            }
            if file_contains_marker(&path, content_marker) {
                std::fs::remove_file(&path)
                    .with_context(|| format!("remove {}", path.display()))?;
            }
        }
        Ok(())
    }

    /// Filesystem-safe slug for an entry id: lowercase ASCII alphanumerics, all
    /// other characters collapsed to `-` and trimmed. Falls back to `entry` when
    /// empty.
    fn slug(entry: &ShellEntry) -> String {
        id_slug(&entry.id, '-', true, "entry")
    }

    /// Nautilus script filename — the display name shown in the Scripts submenu,
    /// with path separators replaced. Falls back to the slug when empty.
    fn nautilus_script_name(entry: &ShellEntry) -> String {
        let base = sanitize_display_name(&entry.name, &['/', '\\']);
        if base.is_empty() {
            slug(entry)
        } else {
            base
        }
    }

    /// Escape a value for a Desktop Entry key: strip the newlines that would
    /// otherwise split the key/value line.
    fn desktop_value(value: &str) -> String {
        value.replace(['\n', '\r'], " ")
    }

    /// Render the universal XDG `.desktop` launcher registering termiHub for the
    /// `inode/directory` MIME type. `NoDisplay=true` keeps it out of the app
    /// menu — it only surfaces under "Open With" for folders.
    fn xdg_desktop_file(entry: &ShellEntry, exe_path: &str) -> String {
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={name}\n\
             Exec={exec}\n\
             Icon={ICON}\n\
             Terminal=false\n\
             NoDisplay=true\n\
             MimeType=inode/directory;\n\
             {DESKTOP_MARKER}\n",
            name = desktop_value(&entry.name),
            exec = spawn_command_line(exe_path, &entry.id, entry.spawn_kind, "%f"),
        )
    }

    /// Render a Nautilus script: a POSIX shell wrapper that spawns termiHub for
    /// the first selected path. Carries the owner marker for uninstall.
    fn nautilus_script(entry: &ShellEntry, exe_path: &str) -> String {
        format!(
            "#!/bin/sh\n\
             {NAUTILUS_MARKER}\n\
             {command}\n",
            command = spawn_command_line(exe_path, &entry.id, entry.spawn_kind, "\"$1\""),
        )
    }

    /// Render a KDE service-menu `.desktop` (KService plugin) exposing the entry
    /// on the folder context menu. Carries the owner marker for uninstall.
    fn kde_service_menu(entry: &ShellEntry, exe_path: &str) -> String {
        format!(
            "[Desktop Entry]\n\
             Type=Service\n\
             ServiceTypes=KonqPopupMenu/Plugin\n\
             MimeType=inode/directory;\n\
             Actions=termihubOpen;\n\
             {DESKTOP_MARKER}\n\
             \n\
             [Desktop Action termihubOpen]\n\
             Name={name}\n\
             Icon={ICON}\n\
             Exec={exec}\n",
            name = desktop_value(&entry.name),
            exec = spawn_command_line(exe_path, &entry.id, entry.spawn_kind, "%f"),
        )
    }

    /// Set mode `0o755` on `path`. This module is Linux-gated, so `unix` always
    /// holds and `PermissionsExt` is always available.
    fn set_executable(path: &Path) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .with_context(|| format!("stat {}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .with_context(|| format!("chmod 0o755 {}", path.display()))?;
        Ok(())
    }

    /// Thunar `uca.xml` editing via a streaming XML reader/writer. termiHub's
    /// actions are appended to the shared file and de-appended on uninstall,
    /// preserving every foreign action already present.
    mod thunar {
        use anyhow::{Context, Result};
        use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
        use quick_xml::{Reader, Writer};

        /// One termiHub custom action to embed in `uca.xml`.
        pub struct Action {
            pub name: String,
            pub unique_id: String,
            pub command: String,
            /// Show for directories.
            pub directories: bool,
            /// Show for regular files.
            pub other_files: bool,
        }

        /// Produce the new `uca.xml` content: preserve every foreign `<action>`
        /// verbatim — together with the comments and whitespace between them —
        /// drop any prior termiHub action (unique-id starting `our_id_prefix`),
        /// then append `ours`. A `None`/blank/invalid `existing` yields a fresh
        /// document containing only `ours`.
        pub fn rewrite(
            existing: Option<&str>,
            ours: &[Action],
            our_id_prefix: &str,
        ) -> Result<String> {
            let mut writer = Writer::new(Vec::new());
            writer
                .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
                .context("write xml decl")?;
            writer
                .write_event(Event::Start(BytesStart::new("actions")))
                .context("write <actions>")?;
            if let Some(xml) = existing {
                let foreign = copy_foreign_actions(xml, our_id_prefix)?;
                // Inject the preserved source bytes verbatim so comments and
                // whitespace between foreign actions survive byte-for-byte.
                writer.get_mut().extend_from_slice(foreign.as_bytes());
            }
            for action in ours {
                write_action(&mut writer, action)?;
            }
            writer
                .write_event(Event::End(BytesEnd::new("actions")))
                .context("write </actions>")?;
            let bytes = writer.into_inner();
            let mut out = String::from_utf8(bytes).context("uca.xml is not valid UTF-8")?;
            out.push('\n');
            Ok(out)
        }

        /// Return the verbatim source bytes of the existing document's
        /// `<actions>` body, minus any top-level `<action>` subtree termiHub
        /// owns (its `<unique-id>` starts with `our_id_prefix`).
        ///
        /// Rather than replaying parsed events — which would normalise comments
        /// and insignificant whitespace — this walks the reader only to learn
        /// the byte offsets (`reader.buffer_position()`) of the body and of each
        /// top-level `<action>…</action>` span, then copies the body slice while
        /// skipping the owned spans. Foreign actions, and every comment and
        /// whitespace run between them, are preserved exactly. A document
        /// without an `<actions>` root yields an empty string.
        fn copy_foreign_actions(xml: &str, our_id_prefix: &str) -> Result<String> {
            let mut reader = Reader::from_str(xml);
            // Depth relative to the <actions> root: 0 = outside, 1 = directly
            // inside <actions>, >=2 = inside an <action> subtree.
            let mut depth = 0usize;
            // Byte range of the <actions> body: from just after the opening tag
            // to just before the closing tag.
            let mut body_start: Option<usize> = None;
            let mut body_end: Option<usize> = None;
            // Start offset of the top-level <action> currently being scanned.
            let mut action_start: Option<usize> = None;
            // Byte ranges of termiHub-owned <action> subtrees to drop, in order.
            let mut owned: Vec<(usize, usize)> = Vec::new();
            let owned_marker = format!("<unique-id>{our_id_prefix}");

            loop {
                // buffer_position() is the offset just past the previously
                // emitted event, i.e. the start of the event about to be read.
                let before = reader.buffer_position() as usize;
                let event = reader.read_event().context("parse uca.xml")?;
                let after = reader.buffer_position() as usize;
                match &event {
                    Event::Eof => break,
                    Event::Start(e) if e.name().as_ref() == b"actions" && depth == 0 => {
                        depth = 1;
                        body_start = Some(after);
                    }
                    Event::End(e) if e.name().as_ref() == b"actions" && depth == 1 => {
                        depth = 0;
                        body_end = Some(before);
                    }
                    Event::Start(e) if e.name().as_ref() == b"action" && depth == 1 => {
                        depth = 2;
                        action_start = Some(before);
                    }
                    Event::End(e) if e.name().as_ref() == b"action" && depth == 2 => {
                        depth = 1;
                        if let Some(start) = action_start.take() {
                            if xml[start..after].contains(&owned_marker) {
                                owned.push((start, after));
                            }
                        }
                    }
                    Event::Start(_) => depth += 1,
                    Event::End(_) => depth = depth.saturating_sub(1),
                    _ => {}
                }
            }

            let (Some(start), Some(end)) = (body_start, body_end) else {
                return Ok(String::new());
            };
            // Copy the body verbatim, skipping the termiHub-owned action spans.
            let mut foreign = String::new();
            let mut cursor = start;
            for (drop_start, drop_end) in owned {
                foreign.push_str(&xml[cursor..drop_start]);
                cursor = drop_end;
            }
            foreign.push_str(&xml[cursor..end]);
            Ok(foreign)
        }

        /// Write one termiHub `<action>` element.
        fn write_action(writer: &mut Writer<Vec<u8>>, action: &Action) -> Result<()> {
            writer
                .write_event(Event::Start(BytesStart::new("action")))
                .context("write <action>")?;
            text_element(writer, "icon", super::ICON)?;
            text_element(writer, "name", &action.name)?;
            text_element(writer, "unique-id", &action.unique_id)?;
            text_element(writer, "command", &action.command)?;
            text_element(writer, "description", "Open in termiHub")?;
            text_element(writer, "patterns", "*")?;
            if action.directories {
                writer
                    .write_event(Event::Empty(BytesStart::new("directories")))
                    .context("write <directories/>")?;
            }
            if action.other_files {
                writer
                    .write_event(Event::Empty(BytesStart::new("other-files")))
                    .context("write <other-files/>")?;
            }
            writer
                .write_event(Event::End(BytesEnd::new("action")))
                .context("write </action>")?;
            Ok(())
        }

        /// Write `<name>value</name>`, escaping `value` via the writer.
        fn text_element(writer: &mut Writer<Vec<u8>>, name: &str, value: &str) -> Result<()> {
            writer
                .write_event(Event::Start(BytesStart::new(name)))
                .with_context(|| format!("write <{name}>"))?;
            writer
                .write_event(Event::Text(BytesText::new(value)))
                .with_context(|| format!("write text for <{name}>"))?;
            writer
                .write_event(Event::End(BytesEnd::new(name)))
                .with_context(|| format!("write </{name}>"))?;
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::connection::shell_integration::{
            LinuxFileManagerToggles, ShellEntry, ShellEntryVisibility, ShowForTargets,
        };
        use std::sync::Mutex;

        const EXE: &str = "/opt/termihub/termiHub";

        /// Throwaway XDG base dirs deleted on drop, plus a recorder for the
        /// desktop-database refresh hook.
        struct TempXdg {
            data_local: PathBuf,
            config: PathBuf,
            db_calls: Arc<Mutex<Vec<PathBuf>>>,
        }

        impl TempXdg {
            fn new(tag: &str) -> Self {
                let base = std::env::temp_dir()
                    .join(format!("termihub-linux-si-{}-{tag}", std::process::id()));
                let _ = std::fs::remove_dir_all(&base);
                let data_local = base.join("data");
                let config = base.join("config");
                std::fs::create_dir_all(&data_local).expect("create temp data dir");
                std::fs::create_dir_all(&config).expect("create temp config dir");
                Self {
                    data_local,
                    config,
                    db_calls: Arc::new(Mutex::new(Vec::new())),
                }
            }

            fn registrar(&self) -> Registrar {
                let calls = Arc::clone(&self.db_calls);
                let hook: DesktopDbHook = Arc::new(move |p: &Path| {
                    calls.lock().expect("db hook lock").push(p.to_path_buf());
                });
                Registrar::for_test(self.data_local.clone(), self.config.clone(), hook)
            }

            fn read(&self, path: &Path) -> String {
                std::fs::read_to_string(path)
                    .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
            }
        }

        impl Drop for TempXdg {
            fn drop(&mut self) {
                if let Some(base) = self.data_local.parent() {
                    let _ = std::fs::remove_dir_all(base);
                }
            }
        }

        fn targets(folders: bool, files: bool, background: bool) -> ShowForTargets {
            ShowForTargets {
                folders,
                files,
                folder_background: background,
            }
        }

        fn entry(id: &str, name: &str, show_for: ShowForTargets) -> ShellEntry {
            ShellEntry {
                id: id.to_string(),
                name: name.to_string(),
                connection_id: None,
                visibility: ShellEntryVisibility::Always,
                show_for,
                container_image: None,
                container_mount: None,
                spawn_kind: SpawnKind::Auto,
                shell: None,
                container_runtime: ContainerRuntime::Auto,
            }
        }

        fn settings(
            entries: Vec<ShellEntry>,
            toggles: LinuxFileManagerToggles,
        ) -> ShellIntegrationSettings {
            ShellIntegrationSettings {
                entries,
                linux_file_managers: toggles,
                ..Default::default()
            }
        }

        fn all_on() -> LinuxFileManagerToggles {
            LinuxFileManagerToggles {
                nautilus: true,
                kde: true,
                thunar: true,
            }
        }

        // ── XDG .desktop ────────────────────────────────────────────────

        #[test]
        fn install_writes_xdg_desktop_and_refreshes_database() {
            let xdg = TempXdg::new("xdg");
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                LinuxFileManagerToggles::default(),
            );
            reg.install(&s, EXE).unwrap();

            let desktop = xdg.data_local.join("applications/termihub-open.desktop");
            assert!(desktop.is_file(), "XDG desktop file missing");
            let content = xdg.read(&desktop);
            assert!(content.contains("MimeType=inode/directory;"));
            assert!(content
                .contains(r#"Exec="/opt/termihub/termiHub" spawn --entry-id open --location %f"#));
            assert!(content.contains("X-TermiHub-Managed=true"));

            // update-desktop-database was invoked with the applications dir.
            let calls = xdg.db_calls.lock().unwrap();
            assert_eq!(calls.as_slice(), &[xdg.data_local.join("applications")]);
        }

        #[test]
        fn xdg_desktop_only_for_directory_entries() {
            let xdg = TempXdg::new("xdg-files-only");
            let reg = xdg.registrar();
            // A files-only entry does not register a directory launcher.
            let s = settings(
                vec![entry("f", "Files", targets(false, true, false))],
                LinuxFileManagerToggles::default(),
            );
            reg.install(&s, EXE).unwrap();
            assert!(!xdg
                .data_local
                .join("applications/termihub-f.desktop")
                .exists());
        }

        // ── Nautilus ────────────────────────────────────────────────────

        #[test]
        fn nautilus_installed_when_detected_and_enabled() {
            let xdg = TempXdg::new("nautilus");
            // Simulate a Nautilus install: the scripts dir exists.
            std::fs::create_dir_all(xdg.data_local.join("nautilus/scripts")).unwrap();
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();

            let script = xdg.data_local.join("nautilus/scripts/Open in termiHub");
            assert!(script.is_file(), "nautilus script missing");
            let content = xdg.read(&script);
            assert!(content.starts_with("#!/bin/sh"));
            assert!(content.contains(r#"spawn --entry-id open --location "$1""#));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&script).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o755, "nautilus script must be 0o755");
            }
        }

        #[test]
        fn nautilus_skipped_when_not_detected() {
            let xdg = TempXdg::new("nautilus-absent");
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();
            assert!(!xdg.data_local.join("nautilus/scripts").exists());
        }

        #[test]
        fn nautilus_skipped_when_toggle_off_and_foreign_scripts_preserved() {
            let xdg = TempXdg::new("nautilus-toggle-off");
            let scripts = xdg.data_local.join("nautilus/scripts");
            std::fs::create_dir_all(&scripts).unwrap();
            std::fs::write(scripts.join("Foreign Script"), "#!/bin/sh\necho hi\n").unwrap();
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                LinuxFileManagerToggles {
                    nautilus: false,
                    kde: true,
                    thunar: true,
                },
            );
            reg.install(&s, EXE).unwrap();
            assert!(!scripts.join("Open in termiHub").exists());
            assert!(scripts.join("Foreign Script").is_file());
        }

        // ── KDE ─────────────────────────────────────────────────────────

        #[test]
        fn kde_service_menu_written_to_both_kde5_and_kde6_when_present() {
            let xdg = TempXdg::new("kde-both");
            let kde5 = xdg.data_local.join("kservices5/ServiceMenus");
            let kde6 = xdg.data_local.join("kio/servicemenus");
            std::fs::create_dir_all(&kde5).unwrap();
            std::fs::create_dir_all(&kde6).unwrap();
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();

            for dir in [&kde5, &kde6] {
                let file = dir.join("termihub-open.desktop");
                assert!(file.is_file(), "KDE menu missing in {}", dir.display());
                let content = xdg.read(&file);
                assert!(content.contains("Type=Service"));
                assert!(content.contains("ServiceTypes=KonqPopupMenu/Plugin"));
                assert!(content.contains("[Desktop Action termihubOpen]"));
                assert!(content.contains(
                    r#"Exec="/opt/termihub/termiHub" spawn --entry-id open --location %f"#
                ));
            }
        }

        #[test]
        fn kde_skipped_when_not_detected() {
            let xdg = TempXdg::new("kde-absent");
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();
            assert!(!xdg.data_local.join("kio/servicemenus").exists());
            assert!(!xdg.data_local.join("kservices5/ServiceMenus").exists());
        }

        // ── Thunar ──────────────────────────────────────────────────────

        #[test]
        fn thunar_appends_action_preserving_foreign() {
            let xdg = TempXdg::new("thunar-append");
            let thunar_dir = xdg.config.join("Thunar");
            std::fs::create_dir_all(&thunar_dir).unwrap();
            // Pre-existing foreign action written by the user.
            let foreign = r#"<?xml version="1.0" encoding="UTF-8"?>
<actions>
<action>
	<icon>utilities-terminal</icon>
	<name>Open Terminal Here</name>
	<unique-id>1616000000000000-1</unique-id>
	<command>exo-open --working-directory %f --launch TerminalEmulator</command>
	<description>Foreign action</description>
	<patterns>*</patterns>
	<directories/>
</action>
</actions>
"#;
            let uca = thunar_dir.join("uca.xml");
            std::fs::write(&uca, foreign).unwrap();

            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();

            let content = xdg.read(&uca);
            // Foreign action preserved.
            assert!(content.contains("Open Terminal Here"));
            assert!(content.contains("1616000000000000-1"));
            // Ours appended.
            assert!(content.contains("<unique-id>termihub-open</unique-id>"));
            assert!(content.contains("spawn --entry-id open --location %f"));
            // Valid single <actions> root with both actions.
            assert_eq!(content.matches("<actions>").count(), 1);
            assert_eq!(content.matches("<action>").count(), 2);
        }

        #[test]
        fn thunar_detected_via_config_dir_without_prior_uca() {
            let xdg = TempXdg::new("thunar-fresh");
            std::fs::create_dir_all(xdg.config.join("Thunar")).unwrap();
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();
            let content = xdg.read(&xdg.config.join("Thunar/uca.xml"));
            assert!(content.contains("<unique-id>termihub-open</unique-id>"));
            assert_eq!(content.matches("<action>").count(), 1);
        }

        #[test]
        fn thunar_reinstall_keeps_single_owned_action() {
            let xdg = TempXdg::new("thunar-idempotent");
            std::fs::create_dir_all(xdg.config.join("Thunar")).unwrap();
            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();
            reg.install(&s, EXE).unwrap();
            let content = xdg.read(&xdg.config.join("Thunar/uca.xml"));
            assert_eq!(
                content
                    .matches("<unique-id>termihub-open</unique-id>")
                    .count(),
                1
            );
        }

        #[test]
        fn thunar_preserves_inter_action_comments_and_whitespace_on_edit_and_remove() {
            let xdg = TempXdg::new("thunar-comments");
            let thunar_dir = xdg.config.join("Thunar");
            std::fs::create_dir_all(&thunar_dir).unwrap();

            // Two foreign actions with a hand-written comment and blank line
            // between them — the exact bytes we require to round-trip intact.
            const FOREIGN_BLOCK: &str = "<action>\n\t<icon>utilities-terminal</icon>\n\t\
<name>Open Terminal Here</name>\n\t<unique-id>1616000000000000-1</unique-id>\n\t\
<command>xterm</command>\n\t<description>Foreign one</description>\n\t<patterns>*</patterns>\n\t\
<directories/>\n</action>\n\n\
<!-- keep this hand-written comment between actions -->\n\
<action>\n\t<icon>edit-copy</icon>\n\t<name>Copy Path</name>\n\t\
<unique-id>1616000000000000-2</unique-id>\n\t<command>echo %f</command>\n\t\
<description>Foreign two</description>\n\t<patterns>*</patterns>\n\t<other-files/>\n</action>";

            // A pre-existing termiHub action trails the foreign block, so both an
            // edit (install) and a removal (uninstall) must leave the foreign
            // block — comment and whitespace included — byte-intact.
            let fixture = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<actions>\n\
<!-- leading comment, keep me too -->\n\
{FOREIGN_BLOCK}\n\
<action>\n\t<icon>utilities-terminal</icon>\n\t<name>Stale termiHub</name>\n\t\
<unique-id>termihub-open</unique-id>\n\t<command>stale</command>\n\t\
<description>Open in termiHub</description>\n\t<patterns>*</patterns>\n\t<directories/>\n\
</action>\n\
</actions>\n"
            );
            let uca = thunar_dir.join("uca.xml");
            std::fs::write(&uca, &fixture).unwrap();

            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );

            // Edit: reinstall rewrites termiHub's action but must not disturb the
            // foreign block, its comment, or the leading comment.
            reg.install(&s, EXE).unwrap();
            let after_edit = xdg.read(&uca);
            assert!(
                after_edit.contains(FOREIGN_BLOCK),
                "inter-action comment/whitespace lost on edit:\n{after_edit}"
            );
            assert!(after_edit.contains("<!-- leading comment, keep me too -->"));
            assert!(after_edit.contains("<unique-id>termihub-open</unique-id>"));

            // Remove: uninstall strips termiHub's action but keeps everything else.
            reg.uninstall().unwrap();
            let after_remove = xdg.read(&uca);
            assert!(
                after_remove.contains(FOREIGN_BLOCK),
                "inter-action comment/whitespace lost on remove:\n{after_remove}"
            );
            assert!(after_remove.contains("<!-- leading comment, keep me too -->"));
            assert!(
                !after_remove.contains("termihub-open"),
                "termiHub action must be removed"
            );
        }

        // ── Detection ───────────────────────────────────────────────────

        #[test]
        fn detect_reports_managers_by_directory_existence() {
            let xdg = TempXdg::new("detect");
            std::fs::create_dir_all(xdg.data_local.join("nautilus/scripts")).unwrap();
            std::fs::create_dir_all(xdg.config.join("Thunar")).unwrap();
            let reg = xdg.registrar();
            let detected = reg.detect();

            let by_id = |id: &str| detected.iter().find(|m| m.id == id).unwrap().detected;
            assert!(by_id("nautilus"));
            assert!(!by_id("kde"));
            assert!(by_id("thunar"));
        }

        // ── Uninstall ───────────────────────────────────────────────────

        #[test]
        fn uninstall_removes_all_four_and_preserves_foreign_thunar_action() {
            let xdg = TempXdg::new("uninstall-all");
            // Detect all managers.
            std::fs::create_dir_all(xdg.data_local.join("nautilus/scripts")).unwrap();
            std::fs::create_dir_all(xdg.data_local.join("kio/servicemenus")).unwrap();
            let thunar_dir = xdg.config.join("Thunar");
            std::fs::create_dir_all(&thunar_dir).unwrap();
            let foreign = r#"<?xml version="1.0" encoding="UTF-8"?>
<actions>
<action>
	<icon>utilities-terminal</icon>
	<name>Open Terminal Here</name>
	<unique-id>1616000000000000-1</unique-id>
	<command>xterm</command>
	<description>Foreign</description>
	<patterns>*</patterns>
	<directories/>
</action>
</actions>
"#;
            let uca = thunar_dir.join("uca.xml");
            std::fs::write(&uca, foreign).unwrap();

            let reg = xdg.registrar();
            let s = settings(
                vec![entry(
                    "open",
                    "Open in termiHub",
                    targets(true, false, false),
                )],
                all_on(),
            );
            reg.install(&s, EXE).unwrap();
            // Sanity: everything got installed.
            assert!(xdg
                .data_local
                .join("applications/termihub-open.desktop")
                .exists());
            assert!(xdg
                .data_local
                .join("nautilus/scripts/Open in termiHub")
                .exists());
            assert!(xdg
                .data_local
                .join("kio/servicemenus/termihub-open.desktop")
                .exists());

            reg.uninstall().unwrap();

            // All four termiHub artifacts gone.
            assert!(!xdg
                .data_local
                .join("applications/termihub-open.desktop")
                .exists());
            assert!(!xdg
                .data_local
                .join("nautilus/scripts/Open in termiHub")
                .exists());
            assert!(!xdg
                .data_local
                .join("kio/servicemenus/termihub-open.desktop")
                .exists());
            let content = xdg.read(&uca);
            assert!(
                !content.contains("termihub-open"),
                "termiHub Thunar action must be removed"
            );
            // Foreign action survives.
            assert!(content.contains("Open Terminal Here"));
            assert!(content.contains("1616000000000000-1"));
        }

        #[test]
        fn uninstall_without_install_is_ok() {
            let xdg = TempXdg::new("uninstall-empty");
            xdg.registrar().uninstall().unwrap();
        }

        #[test]
        fn install_empty_entries_is_noop() {
            let xdg = TempXdg::new("empty");
            let reg = xdg.registrar();
            reg.install(&settings(Vec::new(), all_on()), EXE).unwrap();
            assert!(!xdg.data_local.join("applications").exists());
        }
    }
}
