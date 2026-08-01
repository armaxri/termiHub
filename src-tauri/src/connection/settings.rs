use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::recovery::{RecoveryResult, RecoveryWarning};
use super::shell_integration::ShellIntegrationSettings;
use crate::utils::config_paths::resolve_config_dir;
use crate::utils::fs::write_atomic;

const FILE_NAME: &str = "settings.json";

/// Configuration for a single external connection file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalFileConfig {
    pub path: String,
    pub enabled: bool,
}

/// A Linux `/dev` prefix entry for the serial port scanner.
///
/// Built-in entries (`built_in: true`) can be toggled but not deleted.
/// User-added entries (`built_in: false`) can also be deleted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortScanPrefix {
    pub prefix: String,
    pub enabled: bool,
    pub built_in: bool,
}

/// Returns the full default list of built-in serial port scan prefixes,
/// all enabled, derived from [`termihub_core::session::serial::DEFAULT_EXTRA_LINUX_PREFIXES`].
pub fn default_serial_port_scan_prefixes() -> Vec<SerialPortScanPrefix> {
    termihub_core::session::serial::DEFAULT_EXTRA_LINUX_PREFIXES
        .iter()
        .map(|&prefix| SerialPortScanPrefix {
            prefix: prefix.to_string(),
            enabled: true,
            built_in: true,
        })
        .collect()
}

/// A user-customized keybinding override entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingOverrideEntry {
    pub action: String,
    pub key: String,
}

/// A user-imported custom TextMate grammar for Monaco syntax highlighting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomLanguageGrammar {
    /// Monaco language ID (e.g. "my-lang").
    pub id: String,
    /// Display name shown in the language picker.
    pub name: String,
    /// Full TextMate grammar JSON (stored inline so the original file is not needed).
    pub grammar: serde_json::Value,
}

/// Helper for serde default that returns `true`.
fn default_true() -> bool {
    true
}

/// Default maximum number of retained session-history entries.
fn default_session_history_limit() -> u32 {
    50
}

/// Layout configuration for UI section positioning and visibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutConfig {
    pub activity_bar_position: String,
    pub sidebar_position: String,
    pub sidebar_visible: bool,
    pub status_bar_visible: bool,
    /// Activity bar views hidden by the user via context menu.
    #[serde(default)]
    pub hidden_activity_bar_views: Vec<String>,
    /// The currently active sidebar panel (e.g. "connections", "files").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_view: Option<String>,
    /// Whether the sidebar is currently collapsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sidebar_collapsed: Option<bool>,
}

/// Persisted state for the update checker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdateSettings {
    /// Whether to automatically check for updates on startup and every 24 hours.
    #[serde(default = "default_true")]
    pub auto_check: bool,
    /// ISO 8601 timestamp of the last completed update check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check_time: Option<String>,
    /// Version string the user chose to skip (e.g. `"0.2.0"`). Cleared when a
    /// newer version is released or the user manually clears it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_version: Option<String>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_check_time: None,
            skipped_version: None,
        }
    }
}

/// Application-wide settings persisted to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub version: String,
    pub external_connection_files: Vec<ExternalFileConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_ssh_key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_shell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    /// User-defined custom color themes (#1879). The full shape is owned by the
    /// frontend (`src/themes/types.ts` / `ThemeDefinition[]`); the backend only
    /// persists it verbatim, so it is stored as an opaque JSON value rather than
    /// mirrored as a typed struct. Absent → no custom themes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_themes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u32>,
    /// Terminal line-height multiplier (e.g. `1.0`–`2.0`). `None` → the
    /// frontend default (`1.0`). Owned by the frontend `AppSettings.lineHeight`;
    /// the backend only persists it so it survives a restart (#1735).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_horizontal_scrolling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scrollback_buffer: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    /// Enable xterm's screen-reader mode (#2071). `None`/`Some(false)` keeps it
    /// off (the frontend default) — it is an opt-in accessibility aid. Owned by
    /// the frontend `AppSettings.screenReaderMode`; the backend only persists it
    /// so the toggle survives a restart (#2261).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_reader_mode: Option<bool>,
    #[serde(default = "default_true")]
    pub power_monitoring_enabled: bool,
    #[serde(default = "default_true")]
    pub file_browser_enabled: bool,
    /// Show a confirmation dialog when the user presses the close-tab or
    /// close-tab-group keyboard shortcut. The X-button on a tab is not affected.
    #[serde(default = "default_true")]
    pub confirm_close_tab_on_shortcut: bool,
    /// Show a confirmation dialog before closing a tab or split panel that holds
    /// a live session (via the tab X, middle-click, or panel close button). The
    /// dialog's "Don't ask again" opt-out flips this to `false`. `None` → the
    /// frontend default (treated as `true`). Owned by the frontend
    /// `AppSettings.confirmCloseLiveSession`; the backend only persists it so the
    /// opt-out survives a restart (#1735).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirm_close_live_session: Option<bool>,
    /// Show a one-time notice when closing a tab attached to a persistent
    /// background session, reassuring the user that the session keeps running.
    /// The notice's "Don't show again" opt-out flips this to `false`. Defaults to
    /// `true`. Owned by the frontend `AppSettings.confirmCloseAttachedTab`; the
    /// backend only persists it so the opt-out survives a restart (#2261).
    #[serde(default = "default_true")]
    pub confirm_close_attached_tab: bool,
    /// When true (default), saving terminal content to a file shows a dialog
    /// offering to open the saved file in a Monaco editor tab. When false, the
    /// file is saved silently and no dialog or editor tab is opened.
    #[serde(default = "default_true")]
    pub ask_open_saved_file_in_tab: bool,
    /// Show a warning before starting a Port Scanner scan whose estimated probe
    /// count is very large. The warning's "Don't warn again" opt-out flips this
    /// to `false`. Defaults to `true`. Owned by the frontend
    /// `AppSettings.warnLargePortScan`; persisted here so it survives a restart
    /// (#2261).
    #[serde(default = "default_true")]
    pub warn_large_port_scan: bool,
    /// Show a warning before starting a Ping Sweep across a very large number of
    /// hosts. The warning's "Don't warn again" opt-out flips this to `false`.
    /// Defaults to `true`. Owned by the frontend `AppSettings.warnLargePingSweep`;
    /// persisted here so it survives a restart (#2261).
    #[serde(default = "default_true")]
    pub warn_large_ping_sweep: bool,
    /// Default value for Shell Integration toggle in new SSH connections.
    #[serde(default = "default_true")]
    pub default_shell_integration: bool,
    /// Default value for X11 Forwarding toggle in new SSH connections.
    #[serde(default = "default_true")]
    pub default_x11_forwarding: bool,
    /// Whether termiHub automatically provides a local X server for SSH X11
    /// forwarding (epic #1047). `None` means "use the platform default":
    /// prompt-then-download on Windows, off elsewhere. See
    /// [`crate::terminal::xserver::resolve_provide_automatically`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provide_x_server_automatically: Option<bool>,
    /// Whether a termiHub-managed X server is stopped once its last X11 session
    /// closes (idle shutdown). Defaults to `true`.
    #[serde(default = "default_true")]
    pub stop_x_server_when_idle: bool,
    /// When `true` (default), the open tab groups and layout are auto-saved on
    /// every change and restored on the next startup. When `false`, the app
    /// always starts with a fresh empty session.
    #[serde(default = "default_true")]
    pub restore_last_session_on_startup: bool,
    /// How the previous session is restored on startup: `"never"`, `"ask"`, or
    /// `"always"`. `None` migrates from `restore_last_session_on_startup`
    /// (`false` → `"never"`, otherwise the frontend default `"ask"`). The
    /// frontend owns the resolution (`resolveRestoreMode`); the backend only
    /// persists the chosen value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_last_session_mode: Option<String>,
    /// When true (default), every terminal session opened is recorded to the
    /// browsable session history (`session-history.json`). Turning it off stops
    /// all automatic recording (existing entries are kept).
    #[serde(default = "default_true")]
    pub session_history_enabled: bool,
    /// Maximum number of history entries to retain. When the limit is reached,
    /// the least-recently-used unpinned entry is evicted. Defaults to 50.
    #[serde(default = "default_session_history_limit")]
    pub session_history_limit: u32,
    /// When true (default), the "Recent Sessions" sidebar panel is shown.
    #[serde(default = "default_true")]
    pub show_recent_sessions: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<LayoutConfig>,
    /// Credential storage mode: "master_password" or "none".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_storage_mode: Option<String>,
    /// Auto-lock timeout in minutes for master password mode. None = never.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_auto_lock_minutes: Option<u32>,
    /// Right-click behavior: "contextMenu" or "quickAction". None = platform default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_click_behavior: Option<String>,
    /// Default line ending sent on Enter and used to normalize pasted text:
    /// "cr", "lf", or "crlf". None = frontend default ("lf").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_line_ending: Option<String>,
    /// User-customized keybinding overrides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keybinding_overrides: Option<Vec<KeybindingOverrideEntry>>,
    /// When `true` (default), application shortcuts that collide with standard
    /// shell, tmux, vim, or SSH-to-remote keys are suppressed while the
    /// terminal pane is focused so the keystroke reaches the PTY.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_key_passthrough: Option<bool>,
    /// When `true` (default), an active editor or input-bearing tab handles its
    /// own editing shortcuts (Find, Replace, Select All) — the global keyboard
    /// dispatcher steps aside so the focused widget receives the key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_shortcut_delegation: Option<bool>,
    /// User-defined file extension / filename → language ID mappings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_language_mappings: Option<std::collections::HashMap<String, String>>,
    /// IDs of user-installed Shiki language packages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_language_packages: Option<Vec<String>>,
    /// User-imported custom TextMate grammars (stored inline).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_language_grammars: Option<Vec<CustomLanguageGrammar>>,
    /// Whether experimental features are enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental_features_enabled: Option<bool>,
    /// Experimental opt-in for executing frontend (JavaScript) plugins (#2048).
    /// `None`/`Some(false)` keeps the full-IPC plugin JS surface off by default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontend_plugins_enabled: Option<bool>,
    /// Update checker configuration and state.
    #[serde(default)]
    pub updates: UpdateSettings,
    /// Linux `/dev` prefixes scanned to discover serial ports not found by the
    /// `serialport` crate. `None` means use all built-in defaults (all enabled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_port_scan_prefixes: Option<Vec<SerialPortScanPrefix>>,
    /// Shell context-menu / CLI-spawn integration configuration (epic #1363).
    /// `#[serde(default)]` keeps older settings files forward-compatible.
    #[serde(default)]
    pub shell_integration: ShellIntegrationSettings,
    /// Terminal output syntax-highlighting configuration (epic #1696).
    ///
    /// The full config shape is owned by the frontend
    /// (`src/types/syntaxHighlighting.ts` / `SyntaxHighlightingConfig`); the
    /// backend only persists it verbatim, so it is stored as an opaque JSON
    /// value here rather than mirrored as a typed struct. Absent → the frontend
    /// resolves the built-in defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub syntax_highlighting: Option<serde_json::Value>,
    /// Master opt-in for the guarded `run-local-process` workflow step (#1857).
    ///
    /// Defaults to `false`: a workflow can spawn a local program on the user's
    /// machine only after the user explicitly enables this. Owned by the
    /// frontend `AppSettings.workflowLocalProcessEnabled`; the backend both
    /// persists it and **re-checks it in the spawn command** (defence-in-depth)
    /// so a step can never run without opt-in. `#[serde(default)]` keeps older
    /// settings files forward-compatible (missing → `false`).
    #[serde(default)]
    pub workflow_local_process_enabled: bool,
    /// Programs the user has chosen to always allow a `run-local-process` step
    /// to spawn without re-confirming (#1857). Owned by the frontend
    /// `AppSettings.workflowLocalProcessAllowlist`; persisted here so the
    /// authorization survives a restart. Independent of workflow data, so an
    /// imported workflow can never add an entry.
    #[serde(default)]
    pub workflow_local_process_allowlist: Vec<String>,
    /// Forward-compatibility catch-all (#2311).
    ///
    /// Preserves any field the frontend `AppSettings` interface
    /// (`src/types/connection.ts`) carries that this struct does not model
    /// explicitly. Without it, an unmodelled key is silently dropped when
    /// settings are saved and the user loses that setting on the next restart —
    /// the exact defect class behind #2261 (`confirmCloseAttachedTab` etc.) and
    /// #2309. Unknown keys round-trip verbatim instead. Empty by default, so a
    /// flattened empty map contributes nothing to the serialized output.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: "1".to_string(),
            external_connection_files: Vec::new(),
            default_user: None,
            default_ssh_key_path: None,
            default_shell: None,
            theme: None,
            custom_themes: None,
            font_family: None,
            font_size: None,
            line_height: None,
            default_horizontal_scrolling: None,
            scrollback_buffer: None,
            cursor_style: None,
            cursor_blink: None,
            screen_reader_mode: None,
            power_monitoring_enabled: true,
            file_browser_enabled: true,
            confirm_close_tab_on_shortcut: true,
            confirm_close_live_session: None,
            confirm_close_attached_tab: true,
            ask_open_saved_file_in_tab: true,
            warn_large_port_scan: true,
            warn_large_ping_sweep: true,
            default_shell_integration: true,
            default_x11_forwarding: true,
            provide_x_server_automatically: None,
            stop_x_server_when_idle: true,
            restore_last_session_on_startup: true,
            restore_last_session_mode: None,
            session_history_enabled: true,
            session_history_limit: default_session_history_limit(),
            show_recent_sessions: true,
            layout: None,
            credential_storage_mode: None,
            credential_auto_lock_minutes: None,
            right_click_behavior: None,
            default_line_ending: None,
            keybinding_overrides: None,
            terminal_key_passthrough: None,
            editor_shortcut_delegation: None,
            file_language_mappings: None,
            installed_language_packages: None,
            custom_language_grammars: None,
            experimental_features_enabled: None,
            frontend_plugins_enabled: None,
            updates: UpdateSettings::default(),
            serial_port_scan_prefixes: None,
            shell_integration: ShellIntegrationSettings::default(),
            syntax_highlighting: None,
            workflow_local_process_enabled: false,
            workflow_local_process_allowlist: Vec::new(),
            extra: serde_json::Map::new(),
        }
    }
}

/// Handles reading/writing the settings JSON file.
pub struct SettingsStorage {
    file_path: PathBuf,
}

impl SettingsStorage {
    /// Create a new settings storage instance, resolving the config directory.
    ///
    /// Uses the same directory as `ConnectionStorage` (respects `TERMIHUB_CONFIG_DIR`).
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        let config_dir = resolve_config_dir(Some(app_handle))?;

        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;

        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Create a settings storage instance without a Tauri [`AppHandle`].
    ///
    /// Used by the pre-init CLI subcommands (`install/uninstall-shell-integration`)
    /// which run before the Tauri app — and its path resolver — exist. Passing
    /// `None` to [`resolve_config_dir`] selects the pre-init resolution branch,
    /// which detects portable mode itself (it runs *before* `run()` exports
    /// `TERMIHUB_CONFIG_DIR`) and otherwise reconstructs the OS config dir from
    /// the bundle identifier — equivalent to Tauri's `app_config_dir()`.
    pub fn new_standalone() -> Result<Self> {
        let config_dir = resolve_config_dir(None)?;
        fs::create_dir_all(&config_dir).context("Failed to create config directory")?;
        Ok(Self {
            file_path: config_dir.join(FILE_NAME),
        })
    }

    /// Create a storage instance pointing directly at `file_path`.
    /// Only available in tests; production code must go through `new()`.
    #[cfg(test)]
    pub fn new_for_test(file_path: PathBuf) -> Self {
        Self { file_path }
    }

    /// Load with recovery: on parse failure, backs up the corrupt file and resets to defaults.
    ///
    /// Since `AppSettings` uses `#[serde(default)]`, partial field corruption is handled
    /// by serde itself. Only completely unparseable files need recovery here.
    pub fn load_with_recovery(&self) -> Result<RecoveryResult<AppSettings>> {
        if !self.file_path.exists() {
            return Ok(RecoveryResult {
                data: AppSettings::default(),
                warnings: Vec::new(),
            });
        }

        let data = fs::read_to_string(&self.file_path).context("Failed to read settings file")?;

        // Fast path: normal parse succeeds
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&data) {
            return Ok(RecoveryResult {
                data: settings,
                warnings: Vec::new(),
            });
        }

        // Parse failed — back up and reset to defaults
        let backup_path = self.file_path.with_extension("json.bak");
        let _ = fs::copy(&self.file_path, &backup_path);
        tracing::warn!(
            "Settings file is corrupt, backed up to {}",
            backup_path.display()
        );

        let parse_error = serde_json::from_str::<AppSettings>(&data)
            .err()
            .map(|e| e.to_string());

        let warning = RecoveryWarning {
            file_name: FILE_NAME.to_string(),
            message: "Settings file was corrupt and has been reset to defaults.".to_string(),
            details: parse_error,
        };
        tracing::error!("Settings file corrupt, resetting to defaults");

        let defaults = AppSettings::default();
        self.save(&defaults)
            .context("Failed to save default settings after recovery")?;

        Ok(RecoveryResult {
            data: defaults,
            warnings: vec![warning],
        })
    }

    /// Save settings to disk (pretty-printed JSON).
    pub fn save(&self, settings: &AppSettings) -> Result<()> {
        let data =
            serde_json::to_string_pretty(settings).context("Failed to serialize settings")?;

        write_atomic(&self.file_path, &data).context("Failed to write settings file")?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_storage(dir: &TempDir) -> SettingsStorage {
        SettingsStorage {
            file_path: dir.path().join(FILE_NAME),
        }
    }

    /// Regression (#2320): a `save` that cannot durably complete must fail
    /// **without** clobbering the previously-saved settings. The old
    /// truncate-in-place `fs::write` would succeed by overwriting the existing
    /// file, so this fails red on it; the atomic temp+rename write cannot create
    /// its temp file in a read-only directory and therefore leaves the prior
    /// `settings.json` untouched.
    #[cfg(unix)]
    #[test]
    fn failed_save_preserves_previous_settings() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let original = AppSettings {
            theme: Some("dark".to_string()),
            ..Default::default()
        };
        storage.save(&original).unwrap();
        let before = fs::read_to_string(&storage.file_path).unwrap();

        let restore = fs::metadata(dir.path()).unwrap().permissions();
        let mut ro = restore.clone();
        ro.set_mode(0o500);
        fs::set_permissions(dir.path(), ro).unwrap();

        // A privileged/root process can create files regardless of mode — skip.
        let probe = dir.path().join(".probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            fs::set_permissions(dir.path(), restore).unwrap();
            return;
        }

        let updated = AppSettings {
            theme: Some("light".to_string()),
            ..Default::default()
        };
        let result = storage.save(&updated);
        fs::set_permissions(dir.path(), restore).unwrap();

        assert!(
            result.is_err(),
            "a save that cannot durably complete must report an error"
        );
        let after = fs::read_to_string(&storage.file_path).unwrap();
        assert_eq!(
            before, after,
            "a failed save must leave the previous settings fully intact"
        );
        serde_json::from_str::<AppSettings>(&after).expect("preserved settings still parse");
    }

    #[test]
    fn load_with_recovery_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.version, "1");
        assert!(result.data.power_monitoring_enabled);
    }

    #[test]
    fn load_with_recovery_valid_settings() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        let settings = AppSettings {
            theme: Some("dark".to_string()),
            ..Default::default()
        };
        storage.save(&settings).unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.data.theme.as_deref(), Some("dark"));
    }

    #[test]
    fn load_with_recovery_corrupt_settings() {
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);
        std::fs::write(&storage.file_path, "not valid json {{{").unwrap();

        let result = storage.load_with_recovery().unwrap();
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].message.contains("corrupt"));
        assert!(result.warnings[0].details.is_some());
        // Returns defaults
        assert_eq!(result.data.version, "1");
        assert!(result.data.power_monitoring_enabled);

        // Backup should exist
        let backup = storage.file_path.with_extension("json.bak");
        assert!(backup.exists());
        assert_eq!(
            std::fs::read_to_string(&backup).unwrap(),
            "not valid json {{{"
        );
    }

    #[test]
    fn deserialize_legacy_json_without_new_fields() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.version, "1");
        assert!(settings.external_connection_files.is_empty());
        assert!(settings.default_user.is_none());
        assert!(settings.font_size.is_none());
        assert!(settings.cursor_blink.is_none());
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
        assert!(settings.credential_storage_mode.is_none());
        assert!(settings.credential_auto_lock_minutes.is_none());
    }

    #[test]
    fn deserialize_with_new_fields() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "defaultUser": "admin",
            "fontSize": 16,
            "cursorStyle": "underline",
            "cursorBlink": false,
            "scrollbackBuffer": 10000,
            "defaultHorizontalScrolling": true
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.default_user.as_deref(), Some("admin"));
        assert_eq!(settings.font_size, Some(16));
        assert_eq!(settings.cursor_style.as_deref(), Some("underline"));
        assert_eq!(settings.cursor_blink, Some(false));
        assert_eq!(settings.scrollback_buffer, Some(10000));
        assert_eq!(settings.default_horizontal_scrolling, Some(true));
    }

    #[test]
    fn default_settings_have_features_enabled() {
        let settings = AppSettings::default();
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
        assert!(settings.default_shell_integration);
        assert!(settings.default_x11_forwarding);
        assert!(settings.ask_open_saved_file_in_tab);
        assert!(settings.restore_last_session_on_startup);
    }

    #[test]
    fn backward_compat_deserializes_missing_fields_as_true() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.power_monitoring_enabled);
        assert!(settings.file_browser_enabled);
        assert!(settings.default_shell_integration);
        assert!(settings.default_x11_forwarding);
        assert!(settings.ask_open_saved_file_in_tab);
        assert!(settings.restore_last_session_on_startup);
    }

    #[test]
    fn custom_themes_round_trip_verbatim() {
        // The backend stores customThemes as an opaque JSON passthrough (#1879).
        // A save/load cycle must preserve the full frontend-owned shape so custom
        // themes are not silently dropped.
        let themes = serde_json::json!([{
            "id": "abc-123",
            "name": "Ocean",
            "colorScheme": "dark",
            "baseTheme": "dark",
            "colors": { "bgPrimary": "#012", "accentColor": "#3af" }
        }]);
        let settings = AppSettings {
            theme: Some("custom:abc-123".to_string()),
            custom_themes: Some(themes.clone()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.theme.as_deref(), Some("custom:abc-123"));
        assert_eq!(deserialized.custom_themes, Some(themes));
    }

    #[test]
    fn custom_themes_absent_by_default() {
        assert!(AppSettings::default().custom_themes.is_none());
        // A legacy file without the field deserializes with no custom themes.
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.custom_themes.is_none());
    }

    #[test]
    fn restore_last_session_on_startup_round_trips() {
        let settings = AppSettings {
            restore_last_session_on_startup: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.restore_last_session_on_startup);
    }

    #[test]
    fn restore_last_session_mode_round_trips() {
        // Unset by default and omitted from the serialized JSON.
        let default = AppSettings::default();
        assert!(default.restore_last_session_mode.is_none());
        let default_json = serde_json::to_string(&default).unwrap();
        assert!(!default_json.contains("restoreLastSessionMode"));

        // A set value survives a serialize/deserialize round-trip.
        let settings = AppSettings {
            restore_last_session_mode: Some("ask".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("restoreLastSessionMode"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(
            deserialized.restore_last_session_mode.as_deref(),
            Some("ask")
        );

        // A legacy file without the field deserializes to None.
        let legacy = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let legacy_settings: AppSettings = serde_json::from_str(legacy).unwrap();
        assert!(legacy_settings.restore_last_session_mode.is_none());
    }

    #[test]
    fn x_server_defaults() {
        let settings = AppSettings::default();
        // Provisioning preference is unset (platform default resolved elsewhere).
        assert!(settings.provide_x_server_automatically.is_none());
        // Idle shutdown is on by default.
        assert!(settings.stop_x_server_when_idle);
    }

    #[test]
    fn x_server_provide_none_omitted_but_stop_idle_serialized() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("provideXServerAutomatically"));
        assert!(json.contains("stopXServerWhenIdle"));
    }

    #[test]
    fn x_server_settings_round_trip() {
        let settings = AppSettings {
            provide_x_server_automatically: Some(true),
            stop_x_server_when_idle: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.provide_x_server_automatically, Some(true));
        assert!(!deserialized.stop_x_server_when_idle);
    }

    #[test]
    fn x_server_legacy_json_defaults_stop_idle_true() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.provide_x_server_automatically.is_none());
        assert!(settings.stop_x_server_when_idle);
    }

    #[test]
    fn ssh_defaults_round_trip() {
        let settings = AppSettings {
            default_shell_integration: false,
            default_x11_forwarding: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.default_shell_integration);
        assert!(!deserialized.default_x11_forwarding);
    }

    #[test]
    fn deserializes_explicit_false_values() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "powerMonitoringEnabled": false,
            "fileBrowserEnabled": false
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(!settings.power_monitoring_enabled);
        assert!(!settings.file_browser_enabled);
    }

    #[test]
    fn deserialize_without_layout_field() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.layout.is_none());
    }

    #[test]
    fn deserialize_with_layout_field() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "layout": {
                "activityBarPosition": "right",
                "sidebarPosition": "left",
                "sidebarVisible": true,
                "statusBarVisible": false
            }
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        let layout = settings.layout.unwrap();
        assert_eq!(layout.activity_bar_position, "right");
        assert!(!layout.status_bar_visible);
        // New optional fields default to empty/None when absent
        assert!(layout.hidden_activity_bar_views.is_empty());
        assert!(layout.sidebar_view.is_none());
        assert!(layout.sidebar_collapsed.is_none());
    }

    #[test]
    fn layout_config_persists_sidebar_state() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "layout": {
                "activityBarPosition": "left",
                "sidebarPosition": "left",
                "sidebarVisible": true,
                "statusBarVisible": true,
                "hiddenActivityBarViews": ["tunnels", "services"],
                "sidebarView": "files",
                "sidebarCollapsed": true
            }
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        {
            let layout = settings.layout.as_ref().unwrap();
            assert_eq!(
                layout.hidden_activity_bar_views,
                vec!["tunnels", "services"]
            );
            assert_eq!(layout.sidebar_view.as_deref(), Some("files"));
            assert_eq!(layout.sidebar_collapsed, Some(true));
        }

        // Round-trip
        let serialized = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&serialized).unwrap();
        let layout2 = deserialized.layout.unwrap();
        assert_eq!(
            layout2.hidden_activity_bar_views,
            vec!["tunnels", "services"]
        );
        assert_eq!(layout2.sidebar_view.as_deref(), Some("files"));
        assert_eq!(layout2.sidebar_collapsed, Some(true));
    }

    #[test]
    fn deserialize_without_credential_fields() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.credential_storage_mode.is_none());
        assert!(settings.credential_auto_lock_minutes.is_none());
    }

    #[test]
    fn deserialize_with_credential_fields() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "credentialStorageMode": "master_password",
            "credentialAutoLockMinutes": 15
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.credential_storage_mode.as_deref(),
            Some("master_password")
        );
        assert_eq!(settings.credential_auto_lock_minutes, Some(15));
    }

    #[test]
    fn credential_fields_round_trip_all_modes() {
        for mode in &["master_password", "none"] {
            let settings = AppSettings {
                credential_storage_mode: Some(mode.to_string()),
                credential_auto_lock_minutes: Some(30),
                ..Default::default()
            };

            let json = serde_json::to_string(&settings).unwrap();
            let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

            assert_eq!(deserialized.credential_storage_mode.as_deref(), Some(*mode));
            assert_eq!(deserialized.credential_auto_lock_minutes, Some(30));
        }
    }

    #[test]
    fn credential_none_values_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("credentialStorageMode"));
        assert!(!json.contains("credentialAutoLockMinutes"));
    }

    #[test]
    fn deserialize_without_right_click_behavior() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.right_click_behavior.is_none());
    }

    #[test]
    fn deserialize_with_right_click_behavior() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "rightClickBehavior": "quickAction"
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.right_click_behavior.as_deref(),
            Some("quickAction")
        );
    }

    #[test]
    fn right_click_behavior_round_trip() {
        for mode in &["contextMenu", "quickAction"] {
            let settings = AppSettings {
                right_click_behavior: Some(mode.to_string()),
                ..Default::default()
            };

            let json = serde_json::to_string(&settings).unwrap();
            let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

            assert_eq!(deserialized.right_click_behavior.as_deref(), Some(*mode));
        }
    }

    #[test]
    fn right_click_behavior_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("rightClickBehavior"));
    }

    #[test]
    fn deserialize_without_keybinding_overrides() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.keybinding_overrides.is_none());
    }

    #[test]
    fn deserialize_with_keybinding_overrides() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "keybindingOverrides": [
                {"action": "toggle-sidebar", "key": "Ctrl+Shift+B"},
                {"action": "copy", "key": "Ctrl+C"}
            ]
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        let overrides = settings.keybinding_overrides.unwrap();
        assert_eq!(overrides.len(), 2);
        assert_eq!(overrides[0].action, "toggle-sidebar");
        assert_eq!(overrides[0].key, "Ctrl+Shift+B");
        assert_eq!(overrides[1].action, "copy");
    }

    #[test]
    fn keybinding_overrides_round_trip() {
        let settings = AppSettings {
            keybinding_overrides: Some(vec![KeybindingOverrideEntry {
                action: "paste".to_string(),
                key: "Ctrl+V".to_string(),
            }]),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        let overrides = deserialized.keybinding_overrides.unwrap();
        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].action, "paste");
        assert_eq!(overrides[0].key, "Ctrl+V");
    }

    #[test]
    fn keybinding_overrides_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("keybindingOverrides"));
    }

    #[test]
    fn deserialize_without_editor_language_fields() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.file_language_mappings.is_none());
        assert!(settings.installed_language_packages.is_none());
        assert!(settings.custom_language_grammars.is_none());
    }

    #[test]
    fn editor_language_fields_round_trip() {
        use std::collections::HashMap;

        let mut mappings = HashMap::new();
        mappings.insert(".s16".to_string(), "s16".to_string());

        let grammar_json = serde_json::json!({
            "name": "S16 Assembly",
            "scopeName": "source.s16",
            "patterns": []
        });

        let settings = AppSettings {
            file_language_mappings: Some(mappings),
            installed_language_packages: Some(vec!["lua".to_string(), "rust".to_string()]),
            custom_language_grammars: Some(vec![CustomLanguageGrammar {
                id: "s16".to_string(),
                name: "S16 Assembly".to_string(),
                grammar: grammar_json,
            }]),
            ..Default::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

        let mappings = deserialized.file_language_mappings.unwrap();
        assert_eq!(mappings.get(".s16").map(String::as_str), Some("s16"));

        let packages = deserialized.installed_language_packages.unwrap();
        assert_eq!(packages, vec!["lua", "rust"]);

        let grammars = deserialized.custom_language_grammars.unwrap();
        assert_eq!(grammars.len(), 1);
        assert_eq!(grammars[0].id, "s16");
        assert_eq!(grammars[0].name, "S16 Assembly");
        assert_eq!(
            grammars[0].grammar["scopeName"].as_str(),
            Some("source.s16")
        );
    }

    #[test]
    fn editor_language_fields_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("fileLanguageMappings"));
        assert!(!json.contains("installedLanguagePackages"));
        assert!(!json.contains("customLanguageGrammars"));
    }

    #[test]
    fn workflow_local_process_settings_default_off_and_round_trip() {
        // Default: opt-in OFF, empty allowlist (#1857).
        let defaults = AppSettings::default();
        assert!(!defaults.workflow_local_process_enabled);
        assert!(defaults.workflow_local_process_allowlist.is_empty());

        let settings = AppSettings {
            workflow_local_process_enabled: true,
            workflow_local_process_allowlist: vec!["/usr/bin/notify-send".to_string()],
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("workflowLocalProcessEnabled"));
        assert!(json.contains("workflowLocalProcessAllowlist"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(deserialized.workflow_local_process_enabled);
        assert_eq!(
            deserialized.workflow_local_process_allowlist,
            vec!["/usr/bin/notify-send".to_string()]
        );
    }

    #[test]
    fn workflow_local_process_missing_fields_default_to_disabled() {
        // An older settings file without the fields must load as disabled/empty.
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let deserialized: AppSettings = serde_json::from_str(json).unwrap();
        assert!(!deserialized.workflow_local_process_enabled);
        assert!(deserialized.workflow_local_process_allowlist.is_empty());
    }

    #[test]
    fn experimental_features_enabled_round_trip() {
        let settings = AppSettings {
            experimental_features_enabled: Some(true),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("experimentalFeaturesEnabled"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.experimental_features_enabled, Some(true));
    }

    #[test]
    fn experimental_features_enabled_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("experimentalFeaturesEnabled"));
    }

    #[test]
    fn frontend_plugins_enabled_round_trip() {
        let settings = AppSettings {
            frontend_plugins_enabled: Some(true),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("frontendPluginsEnabled"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.frontend_plugins_enabled, Some(true));
    }

    #[test]
    fn frontend_plugins_enabled_defaults_off_and_omitted() {
        // Off by default (#2048): the field is None on a fresh settings object and
        // omitted from serialized JSON, so v0.1.0 ships with frontend plugins off.
        let settings = AppSettings::default();
        assert_eq!(settings.frontend_plugins_enabled, None);
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("frontendPluginsEnabled"));
    }

    #[test]
    fn syntax_highlighting_round_trip_preserves_opaque_config() {
        let config = serde_json::json!({
            "enabled": true,
            "builtinRules": { "error-keywords": true, "quoted-strings": false },
            "customRules": [
                {
                    "id": "c1",
                    "name": "Custom",
                    "pattern": "foo",
                    "style": { "color": "#123456" },
                    "enabled": true,
                    "priority": 5,
                    "builtin": false
                }
            ]
        });
        let settings = AppSettings {
            syntax_highlighting: Some(config.clone()),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("syntaxHighlighting"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.syntax_highlighting, Some(config));
    }

    #[test]
    fn syntax_highlighting_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("syntaxHighlighting"));
    }

    #[test]
    fn deserialize_without_line_height_and_confirm_close_live_session() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.line_height.is_none());
        assert!(settings.confirm_close_live_session.is_none());
    }

    #[test]
    fn deserialize_with_line_height_and_confirm_close_live_session() {
        let json = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "lineHeight": 1.2,
            "confirmCloseLiveSession": false
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.line_height, Some(1.2));
        assert_eq!(settings.confirm_close_live_session, Some(false));
    }

    #[test]
    fn line_height_and_confirm_close_live_session_round_trip() {
        // Regression for #1735: these two frontend AppSettings fields were
        // absent from the Rust struct and silently dropped on save→load.
        let settings = AppSettings {
            line_height: Some(1.4),
            confirm_close_live_session: Some(false),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("lineHeight"));
        assert!(json.contains("confirmCloseLiveSession"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.line_height, Some(1.4));
        assert_eq!(deserialized.confirm_close_live_session, Some(false));
    }

    #[test]
    fn line_height_and_confirm_close_live_session_none_omitted_from_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(!json.contains("lineHeight"));
        assert!(!json.contains("confirmCloseLiveSession"));
    }

    #[test]
    fn round_trip_serialization() {
        let settings = AppSettings {
            default_user: Some("testuser".to_string()),
            font_family: Some("Fira Code".to_string()),
            font_size: Some(18),
            theme: Some("light".to_string()),
            power_monitoring_enabled: false,
            ..Default::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.default_user.as_deref(), Some("testuser"));
        assert_eq!(deserialized.font_family.as_deref(), Some("Fira Code"));
        assert_eq!(deserialized.font_size, Some(18));
        assert_eq!(deserialized.theme.as_deref(), Some("light"));
        assert!(!deserialized.power_monitoring_enabled);
        assert!(deserialized.file_browser_enabled);
        // Fields left as None should not appear in JSON
        assert!(!json.contains("cursorBlink"));
        assert!(!json.contains("scrollbackBuffer"));
    }

    #[test]
    fn update_settings_default_auto_check_is_true() {
        let settings = UpdateSettings::default();
        assert!(settings.auto_check, "auto_check must default to true");
        assert!(settings.last_check_time.is_none());
        assert!(settings.skipped_version.is_none());
    }

    #[test]
    fn app_settings_default_update_auto_check_is_true() {
        let settings = AppSettings::default();
        assert!(
            settings.updates.auto_check,
            "AppSettings default must have auto_check = true"
        );
    }

    #[test]
    fn update_settings_deserializes_missing_auto_check_as_true() {
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(settings.updates.auto_check);
    }

    #[test]
    fn update_settings_respects_explicit_false() {
        let json = r#"{"version":"1","externalConnectionFiles":[],"updates":{"autoCheck":false}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert!(!settings.updates.auto_check);
    }

    #[test]
    fn shell_integration_absent_deserializes_to_default() {
        // Forward-compat: legacy settings files without the shellIntegration
        // key deserialize into the default (empty, unregistered) shape.
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(
            settings.shell_integration,
            super::super::shell_integration::ShellIntegrationSettings::default()
        );
        assert!(settings.shell_integration.entries.is_empty());
        assert!(!settings.shell_integration.registered);
    }

    #[test]
    fn shell_integration_round_trips_within_app_settings() {
        use super::super::shell_integration::{
            ShellEntry, ShellEntryVisibility, ShellIntegrationFallback, ShellIntegrationSettings,
            ShowForTargets,
        };
        use crate::spawn::SpawnKind;
        use termihub_core::config::ContainerRuntime;
        let settings = AppSettings {
            shell_integration: ShellIntegrationSettings {
                entries: vec![ShellEntry {
                    id: "open".to_string(),
                    name: "Open in termiHub".to_string(),
                    connection_id: Some("saved-a".to_string()),
                    visibility: ShellEntryVisibility::Always,
                    show_for: ShowForTargets::default(),
                    container_image: Some("alpine:3".to_string()),
                    container_mount: Some("/src".to_string()),
                    spawn_kind: SpawnKind::Auto,
                    shell: None,
                    container_runtime: ContainerRuntime::Auto,
                }],
                fallback: ShellIntegrationFallback::SystemDefaultShell,
                open_in_new_window: true,
                registered: true,
                registered_exe_path: Some("/opt/termihub/termiHub".to_string()),
                ..Default::default()
            },
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("shellIntegration"));
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.shell_integration, settings.shell_integration);
    }

    #[test]
    fn update_settings_round_trip() {
        let settings = AppSettings {
            updates: UpdateSettings {
                auto_check: false,
                last_check_time: Some("2026-04-17T14:32:00Z".to_string()),
                skipped_version: Some("0.2.0".to_string()),
            },
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&json).unwrap();
        assert!(!deserialized.updates.auto_check);
        assert_eq!(
            deserialized.updates.last_check_time.as_deref(),
            Some("2026-04-17T14:32:00Z")
        );
        assert_eq!(
            deserialized.updates.skipped_version.as_deref(),
            Some("0.2.0")
        );
    }

    #[test]
    fn dropped_frontend_keys_survive_save_load() {
        // Regression for #2261: confirmCloseAttachedTab, warnLargePortScan,
        // warnLargePingSweep and screenReaderMode existed only in the frontend
        // AppSettings, so save_settings silently dropped them when deserializing
        // into the backend struct — flipping an opt-out off did not survive a
        // restart. This guards the actual persistence path (save→reload the file)
        // against future frontend/backend AppSettings drift.
        let dir = TempDir::new().unwrap();
        let storage = create_test_storage(&dir);

        // Each opt-out / toggle flipped away from its default.
        let incoming = r#"{
            "version": "1",
            "externalConnectionFiles": [],
            "confirmCloseAttachedTab": false,
            "warnLargePortScan": false,
            "warnLargePingSweep": false,
            "screenReaderMode": true
        }"#;
        let settings: AppSettings = serde_json::from_str(incoming).unwrap();
        storage.save(&settings).unwrap();

        // Read the persisted file back as raw JSON: every key must have survived
        // the deserialize→serialize round-trip that save_settings performs.
        let persisted = std::fs::read_to_string(&storage.file_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&persisted).unwrap();
        assert_eq!(value["confirmCloseAttachedTab"], serde_json::json!(false));
        assert_eq!(value["warnLargePortScan"], serde_json::json!(false));
        assert_eq!(value["warnLargePingSweep"], serde_json::json!(false));
        assert_eq!(value["screenReaderMode"], serde_json::json!(true));

        // And they must reload into the typed struct with the flipped values.
        let reloaded = storage.load_with_recovery().unwrap().data;
        assert!(!reloaded.confirm_close_attached_tab);
        assert!(!reloaded.warn_large_port_scan);
        assert!(!reloaded.warn_large_ping_sweep);
        assert_eq!(reloaded.screen_reader_mode, Some(true));
    }

    #[test]
    fn dropped_frontend_keys_defaults() {
        // The three confirm/warn opt-outs default on (true); the screen-reader
        // toggle is an absent-means-off Option (frontend default false).
        let settings = AppSettings::default();
        assert!(settings.confirm_close_attached_tab);
        assert!(settings.warn_large_port_scan);
        assert!(settings.warn_large_ping_sweep);
        assert!(settings.screen_reader_mode.is_none());

        // A legacy file without any of the keys loads with those same defaults.
        let json = r#"{"version":"1","externalConnectionFiles":[]}"#;
        let legacy: AppSettings = serde_json::from_str(json).unwrap();
        assert!(legacy.confirm_close_attached_tab);
        assert!(legacy.warn_large_port_scan);
        assert!(legacy.warn_large_ping_sweep);
        assert!(legacy.screen_reader_mode.is_none());
    }

    #[test]
    fn app_settings_flatten_preserves_unknown_frontend_field() {
        // #2311: a field the backend does not model must round-trip through the
        // `#[serde(flatten)] extra` catch-all instead of being silently dropped
        // on save — the exact failure mode of #2261/#2309. Without the catch-all
        // this assertion fails, which is what makes it a guard.
        let json = serde_json::json!({
            "version": "1",
            "externalConnectionFiles": [],
            "theme": "dark",
            "someFutureSetting": { "a": 1, "b": [true, false] },
            "anotherNewToggle": true,
        });

        let settings: AppSettings = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(
            settings.extra.get("someFutureSetting"),
            json.get("someFutureSetting"),
            "unknown key was not captured by the flatten catch-all",
        );

        let round_tripped = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            round_tripped.get("someFutureSetting"),
            json.get("someFutureSetting")
        );
        assert_eq!(
            round_tripped.get("anotherNewToggle"),
            json.get("anotherNewToggle")
        );
        // A modelled field still deserializes correctly alongside the catch-all.
        assert_eq!(settings.theme.as_deref(), Some("dark"));
    }

    #[test]
    fn app_settings_empty_extra_keeps_serialized_output_clean() {
        // An empty catch-all must not leak an `extra` key into the JSON.
        let settings = AppSettings::default();
        let json = serde_json::to_value(&settings).unwrap();
        assert!(json.get("extra").is_none(), "flatten leaked an `extra` key");
    }
}
