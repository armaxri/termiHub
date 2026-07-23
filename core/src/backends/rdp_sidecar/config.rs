//! RDP connection settings: the deserialized config plus the schema the shared
//! connection editor renders.
//!
//! The schema is the **shared field base** (#1680) plus RDP-specific rows —
//! layered through the existing schema system, so the user sees the same editor
//! as every other graphical type, only the protocol-specific rows differ. This
//! is the additive seam: the RDP backend never edits a hand-written editor
//! switch. Unlike VNC, RDP carries a **domain** field, a **security-mode**
//! select (Auto / NLA / TLS / legacy RDP), and **certificate-error** handling.
//!
//! Ported from the parked #1682 branch. Unchanged except that [`RdpConfig`] now
//! also derives [`Serialize`]: it crosses the sidecar IPC boundary
//! (`HostMessage::Connect`) as the connect payload, so it must round-trip.

use serde::{Deserialize, Serialize};

use crate::connection::schema::{Condition, FieldType, SelectOption, SettingsField, SettingsGroup};
use crate::connection::{shared_field_base, SettingsSchema};

/// Standard RDP TCP port.
pub const RDP_DEFAULT_PORT: u16 = 3389;

/// Default initial desktop width requested from the server, in pixels.
pub const DEFAULT_WIDTH: u16 = 1280;
/// Default initial desktop height requested from the server, in pixels.
pub const DEFAULT_HEIGHT: u16 = 800;

/// The security mode the client negotiates with the RDP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecurityMode {
    /// Let the server pick the strongest mutually-supported protocol.
    Auto,
    /// Network Level Authentication (CredSSP) — the secure default for modern hosts.
    Nla,
    /// TLS (standard RDP security over TLS) without CredSSP pre-authentication.
    Tls,
    /// Legacy "Standard RDP Security" (RC4). Insecure; shown behind a warning.
    Rdp,
}

impl SecurityMode {
    /// Parse the schema select value (`"auto" | "nla" | "tls" | "rdp"`),
    /// defaulting to [`SecurityMode::Auto`] for unknown/empty input.
    pub fn from_value(value: &str) -> Self {
        match value.to_ascii_lowercase().as_str() {
            "nla" => SecurityMode::Nla,
            "tls" => SecurityMode::Tls,
            "rdp" => SecurityMode::Rdp,
            _ => SecurityMode::Auto,
        }
    }

    /// Whether this mode is the insecure legacy RC4 path (the frontend shows a
    /// security warning for it).
    pub fn is_legacy(self) -> bool {
        matches!(self, SecurityMode::Rdp)
    }
}

/// Deserialized RDP connection settings.
///
/// A superset of the shared field base plus the RDP-specific rows. Unknown keys
/// (e.g. frontend-only `scaleMode`, `autoReconnect`) are ignored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RdpConfig {
    /// Target host.
    pub host: String,
    /// TCP port (defaults to 3389).
    pub port: u16,
    /// Username for authentication.
    pub username: String,
    /// Password for authentication.
    pub password: String,
    /// Windows domain (RDP-specific; VNC has none). Empty means no domain.
    pub domain: String,
    /// Security mode select value: `"auto" | "nla" | "tls" | "rdp"`.
    pub security_mode: String,
    /// Accept a mismatched / untrusted server certificate instead of failing.
    pub ignore_cert_errors: bool,
    /// Suppress all keyboard/mouse input when `true`.
    pub view_only: bool,
    /// Initial requested desktop width in pixels.
    pub width: Option<u16>,
    /// Initial requested desktop height in pixels.
    pub height: Option<u16>,
    /// Shared field-base color depth select (`"32" | "24" | "16" | "8"`).
    pub color_depth: String,
    /// Opt in to drive redirection (RDPDR): expose [`Self::shared_folder_path`]
    /// to the remote session as a mapped drive. Off by default; enabling it with
    /// no valid path is a no-op (#1757).
    pub drive_redirection: bool,
    /// The single local folder shared with the remote when
    /// [`Self::drive_redirection`] is on. Only this folder is exposed — never the
    /// whole filesystem (#1757).
    pub shared_folder_path: String,
    /// User-visible name for the redirected drive; the remote shows it as
    /// "`<drive_name>` on termiHub". Defaults to `termiHub` when empty (#1757).
    pub drive_name: String,
    /// Opt in to audio output redirection (rdpsnd): play the remote session's
    /// audio on the local host. Off by default; the sidecar advertises PCM
    /// formats and plays received `wave` PDUs through a host output device
    /// (#1764). Audible playback is currently macOS/Windows only — the Linux
    /// build omits the audio backend (see the #1764 Linux follow-up).
    pub audio_redirection: bool,
    /// Opt in to CLIPRDR file transfer (#1765): when the remote copies files to
    /// its clipboard, download them into the shared folder ([`Self::shared_folder_path`]).
    /// Requires [`Self::drive_redirection`] and a valid shared folder — that
    /// folder is already remote-writable via drive redirection, so receiving
    /// clipboard files into it grants the remote no new local access. Off by
    /// default.
    pub clipboard_file_transfer: bool,
    /// Opt in to advertising files copied to the **host OS clipboard** to the
    /// remote so the user can paste them into the session (#1808). Independent of
    /// drive redirection and the shared folder: host-clipboard files are served
    /// from their real host paths, never the shared folder, so this needs no
    /// [`Self::shared_folder_path`] / [`Self::drive_redirection`]. Still gated by
    /// [`Self::view_only`] and the sidecar's serve bounds. Off by default; the
    /// shared-folder opt-in ([`Self::clipboard_file_transfer`]) is unaffected.
    pub paste_local_files: bool,
    /// Surface remote-copied clipboard files to the host OS clipboard with
    /// **delayed rendering** instead of eagerly downloading them into the shared
    /// folder (#1793): the sidecar sends the host only the file *list* on a
    /// remote copy and streams a file's bytes over CLIPRDR on demand when the
    /// user actually pastes locally. Off by default — a host that cannot bind its
    /// OS clipboard's delayed-render hook leaves this unset and keeps the eager
    /// [`Self::clipboard_file_transfer`] shared-folder path as the fallback. Set
    /// by the host process, not the connection editor: it reflects a host OS
    /// capability, not a user preference, so it is not part of
    /// [`rdp_settings_schema`].
    pub clipboard_delayed_render: bool,
}

impl Default for RdpConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: RDP_DEFAULT_PORT,
            username: String::new(),
            password: String::new(),
            domain: String::new(),
            security_mode: "auto".to_string(),
            ignore_cert_errors: false,
            view_only: false,
            width: None,
            height: None,
            color_depth: "32".to_string(),
            drive_redirection: false,
            shared_folder_path: String::new(),
            drive_name: String::new(),
            audio_redirection: false,
            clipboard_file_transfer: false,
            paste_local_files: false,
            clipboard_delayed_render: false,
        }
    }
}

/// Whether this host build can bind remote-copied clipboard files onto the OS
/// clipboard for a delayed-render local paste (#1804).
///
/// **macOS** has the native `NSPasteboard` promised-data binding
/// (`src-tauri/src/macos_clipboard.rs`, #1804) and **Windows** has the `CF_HDROP`
/// delayed-render binding (`src-tauri/src/windows_clipboard.rs`, #1814), so those
/// are the platforms where the sidecar surfaces the file list for delayed
/// rendering; every other platform keeps the eager shared-folder download (#1765)
/// as the fallback. The host process stamps
/// [`RdpConfig::clipboard_delayed_render`] from this at connect time — it reflects
/// a platform capability, not a user preference, so it is deliberately absent from
/// [`rdp_settings_schema`]. The Linux (X11/Wayland `text/uri-list`) binding is
/// tracked as a follow-up (#1815); wiring one here is a single-line change.
pub const fn host_supports_clipboard_delayed_render() -> bool {
    cfg!(any(target_os = "macos", windows))
}

impl RdpConfig {
    /// The effective TCP port to reach the RDP server on.
    pub fn effective_port(&self) -> u16 {
        if self.port == 0 {
            RDP_DEFAULT_PORT
        } else {
            self.port
        }
    }

    /// The negotiated [`SecurityMode`].
    pub fn security(&self) -> SecurityMode {
        SecurityMode::from_value(&self.security_mode)
    }

    /// The initial desktop width to request (clamped to a sane minimum).
    pub fn desktop_width(&self) -> u16 {
        self.width.filter(|w| *w > 0).unwrap_or(DEFAULT_WIDTH)
    }

    /// The initial desktop height to request (clamped to a sane minimum).
    pub fn desktop_height(&self) -> u16 {
        self.height.filter(|h| *h > 0).unwrap_or(DEFAULT_HEIGHT)
    }

    /// Parse the shared-base color-depth select into bits-per-pixel, defaulting
    /// to 32 for unknown/empty input.
    pub fn color_depth_bpp(&self) -> u32 {
        match self.color_depth.as_str() {
            "8" => 8,
            "16" => 16,
            "24" => 24,
            _ => 32,
        }
    }

    /// The canonicalised root folder to redirect as a drive, or `None` when
    /// redirection is off, unconfigured, or the path is not an existing
    /// directory (#1757).
    ///
    /// Resolving here — in the sidecar's own process, on the same machine as the
    /// files — means an invalid or disabled path simply announces no device,
    /// exposing nothing. Only this exact folder is ever shared.
    pub fn shared_drive_root(&self) -> Option<std::path::PathBuf> {
        if !self.drive_redirection {
            return None;
        }
        let path = self.shared_folder_path.trim();
        if path.is_empty() {
            return None;
        }
        let canonical = std::fs::canonicalize(path).ok()?;
        canonical.is_dir().then_some(canonical)
    }

    /// Whether audio output redirection (rdpsnd playback) is opted in (#1764).
    pub fn audio_enabled(&self) -> bool {
        self.audio_redirection
    }

    /// The canonicalised destination folder for files received over CLIPRDR file
    /// transfer, or `None` when the feature is off or the shared folder is not a
    /// valid directory (#1765).
    ///
    /// File transfer reuses the drive-redirection share root: that folder is
    /// already exposed read-write to the remote via #1757, so receiving
    /// clipboard files into it exposes nothing further. Gating on
    /// [`Self::shared_drive_root`] keeps the "only this one opted-in folder"
    /// guarantee in a single place.
    pub fn clipboard_download_dir(&self) -> Option<std::path::PathBuf> {
        if !self.clipboard_file_transfer {
            return None;
        }
        self.shared_drive_root()
    }

    /// Whether the sidecar should advertise files copied to the host OS clipboard
    /// to the remote so the user can paste them into the session (#1808).
    ///
    /// Decoupled from drive redirection and [`Self::clipboard_download_dir`]:
    /// host-clipboard files are served from their real host paths, so this needs
    /// no shared folder. View-only suppression and the sidecar's serve bounds
    /// (8 MiB chunking; the remote only selects advertised indices) still apply —
    /// they are enforced in the sidecar, which combines this with `view_only`.
    pub fn host_clipboard_files_enabled(&self) -> bool {
        self.paste_local_files
    }

    /// Whether the sidecar should surface remote-copied clipboard files to the
    /// host for delayed rendering rather than eagerly downloading them (#1793).
    ///
    /// Only meaningful when clipboard file transfer is opted in
    /// ([`Self::clipboard_download_dir`] resolves): with no shared folder there is
    /// nothing to fall back to, and the whole file path stays off. Gating both on
    /// the same opt-in keeps the "one opted-in folder" guarantee in one place.
    pub fn clipboard_delayed_render_enabled(&self) -> bool {
        self.clipboard_delayed_render && self.clipboard_download_dir().is_some()
    }

    /// The user-visible label for the redirected drive, defaulting to `termiHub`
    /// when unset (#1757).
    pub fn drive_label(&self) -> String {
        let name = self.drive_name.trim();
        if name.is_empty() {
            "termiHub".to_string()
        } else {
            name.to_string()
        }
    }
}

fn field(key: &str, label: &str, field_type: FieldType) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: None,
        help_text: None,
        field_type,
        required: false,
        default: None,
        placeholder: None,
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: None,
    }
}

/// Only shown when the legacy `rdp` security mode is selected — the certificate
/// toggle is meaningful for the TLS-bearing modes; it is always visible so the
/// user can pre-toggle it, but the warning wording lives in the frontend.
fn when_security_is(mode: &str) -> Option<Condition> {
    Some(Condition {
        field: "securityMode".to_string(),
        equals: serde_json::json!(mode),
    })
}

/// Show a field only when the boolean field `field` is enabled — used to hide
/// the drive-redirection path/name rows until redirection is turned on (#1757).
fn when_field_is_true(field: &str) -> Option<Condition> {
    Some(Condition {
        field: field.to_string(),
        equals: serde_json::json!(true),
    })
}

/// The RDP connection editor schema: the shared field base plus the RDP-specific
/// **RDP Options** group (domain, security mode, certificate handling).
pub fn rdp_settings_schema() -> SettingsSchema {
    let mut groups = shared_field_base(RDP_DEFAULT_PORT);

    groups.push(SettingsGroup {
        key: "rdp".to_string(),
        label: "RDP Options".to_string(),
        fields: vec![
            SettingsField {
                supports_env_expansion: true,
                description: Some(
                    "Windows domain for authentication. Leave empty for a local account or a \
                     user@domain UPN."
                        .to_string(),
                ),
                placeholder: Some("WORKGROUP".to_string()),
                ..field("domain", "Domain", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!("auto")),
                description: Some(
                    "How the session is secured. NLA (CredSSP) is recommended; legacy RDP \
                     security is insecure and offered only for old servers."
                        .to_string(),
                ),
                ..field(
                    "securityMode",
                    "Security",
                    FieldType::Select {
                        options: vec![
                            SelectOption {
                                value: "auto".to_string(),
                                label: "Auto (negotiate)".to_string(),
                            },
                            SelectOption {
                                value: "nla".to_string(),
                                label: "NLA (CredSSP)".to_string(),
                            },
                            SelectOption {
                                value: "tls".to_string(),
                                label: "TLS".to_string(),
                            },
                            SelectOption {
                                value: "rdp".to_string(),
                                label: "Legacy RDP (insecure)".to_string(),
                            },
                        ],
                    },
                )
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Connect even when the server certificate is untrusted or its name does not \
                     match. Reduces security — use only for hosts you trust."
                        .to_string(),
                ),
                ..field(
                    "ignoreCertErrors",
                    "Ignore Certificate Errors",
                    FieldType::Boolean,
                )
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Share a local folder with the remote session as a mapped drive. The remote \
                     can read and write the files in that folder — enable only for hosts you \
                     trust."
                        .to_string(),
                ),
                ..field(
                    "driveRedirection",
                    "Redirect a Local Drive",
                    FieldType::Boolean,
                )
            },
            SettingsField {
                supports_env_expansion: true,
                supports_tilde_expansion: true,
                visible_when: when_field_is_true("driveRedirection"),
                description: Some(
                    "The single local folder exposed to the remote when drive redirection is on. \
                     Only this folder is shared, never the whole filesystem."
                        .to_string(),
                ),
                placeholder: Some("/path/to/shared/folder".to_string()),
                ..field("sharedFolderPath", "Shared Folder", FieldType::Text)
            },
            SettingsField {
                visible_when: when_field_is_true("driveRedirection"),
                description: Some(
                    "Name the redirected drive appears under in the remote session (shown as \
                     \"<name> on termiHub\"). Defaults to \"termiHub\"."
                        .to_string(),
                ),
                placeholder: Some("termiHub".to_string()),
                ..field("driveName", "Drive Name", FieldType::Text)
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Play the remote session's audio on this computer. Currently available on \
                     macOS and Windows; Linux support is planned."
                        .to_string(),
                ),
                ..field(
                    "audioRedirection",
                    "Redirect Audio Output",
                    FieldType::Boolean,
                )
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                visible_when: when_field_is_true("driveRedirection"),
                description: Some(
                    "Save files copied to the clipboard on the remote into the shared folder. \
                     Requires drive redirection; files land only in that already-shared folder."
                        .to_string(),
                ),
                ..field(
                    "clipboardFileTransfer",
                    "Receive Clipboard Files",
                    FieldType::Boolean,
                )
            },
            SettingsField {
                default: Some(serde_json::json!(false)),
                description: Some(
                    "Let files you copy on this computer be pasted into the remote session. Does \
                     not need a shared folder — copied files are read from their real location \
                     only when the remote pastes."
                        .to_string(),
                ),
                ..field(
                    "pasteLocalFiles",
                    "Paste Local Files into Remote",
                    FieldType::Boolean,
                )
            },
        ],
    });

    // Silence the unused helper if no field currently uses a security condition;
    // keeping it available documents the conditional-visibility seam.
    let _ = when_security_is;

    SettingsSchema { groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_target_port_3389() {
        let cfg = RdpConfig::default();
        assert_eq!(cfg.port, 3389);
        assert_eq!(cfg.effective_port(), 3389);
        assert_eq!(cfg.security(), SecurityMode::Auto);
        assert!(!cfg.ignore_cert_errors);
    }

    #[test]
    fn zero_port_falls_back_to_default() {
        let cfg = RdpConfig {
            port: 0,
            ..Default::default()
        };
        assert_eq!(cfg.effective_port(), 3389);
    }

    #[test]
    fn security_mode_parses_all_values() {
        assert_eq!(SecurityMode::from_value("auto"), SecurityMode::Auto);
        assert_eq!(SecurityMode::from_value("NLA"), SecurityMode::Nla);
        assert_eq!(SecurityMode::from_value("tls"), SecurityMode::Tls);
        assert_eq!(SecurityMode::from_value("rdp"), SecurityMode::Rdp);
        // Unknown → Auto.
        assert_eq!(SecurityMode::from_value("bogus"), SecurityMode::Auto);
        assert!(SecurityMode::Rdp.is_legacy());
        assert!(!SecurityMode::Nla.is_legacy());
    }

    #[test]
    fn desktop_size_defaults_and_overrides() {
        let cfg = RdpConfig::default();
        assert_eq!(cfg.desktop_width(), DEFAULT_WIDTH);
        assert_eq!(cfg.desktop_height(), DEFAULT_HEIGHT);
        let sized = RdpConfig {
            width: Some(1920),
            height: Some(1080),
            ..Default::default()
        };
        assert_eq!(sized.desktop_width(), 1920);
        assert_eq!(sized.desktop_height(), 1080);
        // Zero is treated as "unset".
        let zeroed = RdpConfig {
            width: Some(0),
            ..Default::default()
        };
        assert_eq!(zeroed.desktop_width(), DEFAULT_WIDTH);
    }

    #[test]
    fn color_depth_parses() {
        for (val, bpp) in [("8", 8), ("16", 16), ("24", 24), ("32", 32), ("x", 32)] {
            let cfg = RdpConfig {
                color_depth: val.to_string(),
                ..Default::default()
            };
            assert_eq!(cfg.color_depth_bpp(), bpp);
        }
    }

    #[test]
    fn unknown_frontend_only_keys_are_ignored() {
        let cfg: RdpConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "scaleMode": "fit", "autoReconnect": true
        }))
        .unwrap();
        assert_eq!(cfg.host, "h");
    }

    #[test]
    fn domain_deserializes() {
        let cfg: RdpConfig = serde_json::from_value(serde_json::json!({
            "host": "h", "domain": "CORP", "securityMode": "nla"
        }))
        .unwrap();
        assert_eq!(cfg.domain, "CORP");
        assert_eq!(cfg.security(), SecurityMode::Nla);
    }

    #[test]
    fn config_round_trips_through_serde() {
        // RdpConfig crosses the IPC boundary, so Serialize→Deserialize must be
        // lossless for every field the sidecar relies on.
        let cfg = RdpConfig {
            host: "host".to_string(),
            port: 3390,
            username: "user".to_string(),
            password: "secret".to_string(),
            domain: "CORP".to_string(),
            security_mode: "nla".to_string(),
            ignore_cert_errors: true,
            view_only: true,
            width: Some(1600),
            height: Some(900),
            color_depth: "16".to_string(),
            drive_redirection: true,
            shared_folder_path: "/tmp/share".to_string(),
            drive_name: "Docs".to_string(),
            audio_redirection: true,
            clipboard_file_transfer: true,
            paste_local_files: true,
            clipboard_delayed_render: true,
        };
        let json = serde_json::to_value(&cfg).unwrap();
        let back: RdpConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back.host, "host");
        assert_eq!(back.port, 3390);
        assert_eq!(back.password, "secret");
        assert_eq!(back.domain, "CORP");
        assert_eq!(back.security(), SecurityMode::Nla);
        assert!(back.ignore_cert_errors);
        assert!(back.view_only);
        assert_eq!(back.desktop_width(), 1600);
        assert_eq!(back.color_depth_bpp(), 16);
        assert!(back.drive_redirection);
        assert_eq!(back.shared_folder_path, "/tmp/share");
        assert_eq!(back.drive_label(), "Docs");
        assert!(back.audio_enabled());
        assert!(back.clipboard_file_transfer);
        assert!(back.paste_local_files);
        assert!(back.host_clipboard_files_enabled());
        assert!(back.clipboard_delayed_render);
    }

    #[test]
    fn host_clipboard_files_decoupled_from_shared_folder() {
        // Off by default.
        assert!(!RdpConfig::default().host_clipboard_files_enabled());
        // Enabled with no drive redirection / shared folder at all — the whole
        // point of #1808: pasting locally-copied files does not need a shared
        // folder, so the gate is independent of `clipboard_download_dir`.
        let paste_only = RdpConfig {
            paste_local_files: true,
            ..Default::default()
        };
        assert!(paste_only.host_clipboard_files_enabled());
        assert!(paste_only.clipboard_download_dir().is_none());
        // The shared-folder opt-in does not imply host-clipboard serving, and vice
        // versa — the two flags are independent.
        let dir = tempfile::tempdir().unwrap();
        let share_only = RdpConfig {
            drive_redirection: true,
            shared_folder_path: dir.path().to_string_lossy().into_owned(),
            clipboard_file_transfer: true,
            ..Default::default()
        };
        assert!(!share_only.host_clipboard_files_enabled());
        assert!(share_only.clipboard_download_dir().is_some());
    }

    #[test]
    fn schema_exposes_paste_local_files_toggle_independently() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        let field = group
            .fields
            .iter()
            .find(|f| f.key == "pasteLocalFiles")
            .expect("RDP schema must expose pasteLocalFiles");
        assert_eq!(field.default, Some(serde_json::json!(false)));
        // Unlike clipboardFileTransfer, it is NOT hidden behind drive redirection —
        // it needs no shared folder, so it is always visible.
        assert!(
            field.visible_when.is_none(),
            "pasteLocalFiles must be independent of drive redirection"
        );
    }

    #[test]
    fn delayed_render_requires_opt_in_and_shared_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        // Fully opted into file transfer with a valid folder and the flag on.
        let on = RdpConfig {
            drive_redirection: true,
            shared_folder_path: path.clone(),
            clipboard_file_transfer: true,
            clipboard_delayed_render: true,
            ..Default::default()
        };
        assert!(on.clipboard_delayed_render_enabled());
        // Flag on but file transfer off → no fallback folder, so the whole path
        // stays off.
        let no_transfer = RdpConfig {
            drive_redirection: true,
            shared_folder_path: path,
            clipboard_file_transfer: false,
            clipboard_delayed_render: true,
            ..Default::default()
        };
        assert!(!no_transfer.clipboard_delayed_render_enabled());
        // Default is off.
        assert!(!RdpConfig::default().clipboard_delayed_render_enabled());
    }

    #[test]
    fn host_capability_flag_matches_the_build_platform() {
        // Delayed rendering is bound to the OS clipboard on macOS (#1804) and
        // Windows (#1814); every other platform keeps the eager shared-folder
        // download (#1765).
        assert_eq!(
            host_supports_clipboard_delayed_render(),
            cfg!(any(target_os = "macos", windows))
        );
    }

    #[test]
    fn delayed_render_is_not_a_schema_field() {
        // It reflects a host OS capability set by the host process, not a user
        // preference — so it must not appear in the connection editor schema.
        let schema = rdp_settings_schema();
        let has_field = schema
            .groups
            .iter()
            .flat_map(|g| &g.fields)
            .any(|f| f.key == "clipboardDelayedRender");
        assert!(!has_field, "delayed-render must not be a schema field");
    }

    #[test]
    fn clipboard_download_dir_requires_opt_in_and_shared_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        // Feature off → no destination even with a valid shared folder.
        let off = RdpConfig {
            drive_redirection: true,
            shared_folder_path: path.clone(),
            clipboard_file_transfer: false,
            ..Default::default()
        };
        assert!(off.clipboard_download_dir().is_none());
        // Feature on but drive redirection off → no destination (folder not shared).
        let no_share = RdpConfig {
            drive_redirection: false,
            shared_folder_path: path.clone(),
            clipboard_file_transfer: true,
            ..Default::default()
        };
        assert!(no_share.clipboard_download_dir().is_none());
        // Fully opted in with a valid folder → resolves to the canonical folder.
        let on = RdpConfig {
            drive_redirection: true,
            shared_folder_path: path,
            clipboard_file_transfer: true,
            ..Default::default()
        };
        assert_eq!(
            on.clipboard_download_dir(),
            Some(std::fs::canonicalize(dir.path()).unwrap())
        );
    }

    #[test]
    fn schema_exposes_clipboard_file_transfer_toggle() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        let field = group
            .fields
            .iter()
            .find(|f| f.key == "clipboardFileTransfer")
            .expect("RDP schema must expose clipboardFileTransfer");
        assert_eq!(field.default, Some(serde_json::json!(false)));
        // Hidden until drive redirection is enabled.
        assert_eq!(
            field.visible_when.as_ref().map(|c| c.field.as_str()),
            Some("driveRedirection")
        );
    }

    #[test]
    fn audio_redirection_defaults_off() {
        assert!(!RdpConfig::default().audio_enabled());
        let on = RdpConfig {
            audio_redirection: true,
            ..Default::default()
        };
        assert!(on.audio_enabled());
    }

    #[test]
    fn schema_exposes_audio_redirection_toggle() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        let audio = group
            .fields
            .iter()
            .find(|f| f.key == "audioRedirection")
            .expect("RDP schema must expose audioRedirection");
        assert_eq!(audio.default, Some(serde_json::json!(false)));
    }

    #[test]
    fn drive_redirection_disabled_or_unset_shares_nothing() {
        // Off by default: no root, nothing exposed.
        assert!(RdpConfig::default().shared_drive_root().is_none());
        // Enabled but no path → still nothing.
        let no_path = RdpConfig {
            drive_redirection: true,
            ..Default::default()
        };
        assert!(no_path.shared_drive_root().is_none());
        // Enabled with a non-existent path → nothing (announces no device).
        let bad_path = RdpConfig {
            drive_redirection: true,
            shared_folder_path: "/no/such/termihub/dir".to_string(),
            ..Default::default()
        };
        assert!(bad_path.shared_drive_root().is_none());
        // Path set but the flag off → still nothing.
        let flag_off = RdpConfig {
            drive_redirection: false,
            shared_folder_path: "/tmp".to_string(),
            ..Default::default()
        };
        assert!(flag_off.shared_drive_root().is_none());
    }

    #[test]
    fn drive_redirection_resolves_an_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = RdpConfig {
            drive_redirection: true,
            shared_folder_path: dir.path().to_string_lossy().into_owned(),
            ..Default::default()
        };
        let root = cfg.shared_drive_root().expect("existing dir must resolve");
        assert_eq!(root, std::fs::canonicalize(dir.path()).unwrap());
        // A file (not a directory) is rejected.
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        let file_cfg = RdpConfig {
            drive_redirection: true,
            shared_folder_path: file.to_string_lossy().into_owned(),
            ..Default::default()
        };
        assert!(file_cfg.shared_drive_root().is_none());
    }

    #[test]
    fn drive_label_defaults_to_termihub_when_empty() {
        assert_eq!(RdpConfig::default().drive_label(), "termiHub");
        let named = RdpConfig {
            drive_name: "  Projects  ".to_string(),
            ..Default::default()
        };
        assert_eq!(named.drive_label(), "Projects");
    }

    #[test]
    fn schema_exposes_drive_redirection_rows() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        for key in ["driveRedirection", "sharedFolderPath", "driveName"] {
            assert!(
                group.fields.iter().any(|f| f.key == key),
                "RDP schema must expose {key}"
            );
        }
        // The path/name rows are hidden until redirection is enabled.
        let path = group
            .fields
            .iter()
            .find(|f| f.key == "sharedFolderPath")
            .unwrap();
        assert_eq!(
            path.visible_when.as_ref().map(|c| c.field.as_str()),
            Some("driveRedirection")
        );
    }

    #[test]
    fn schema_extends_shared_base_with_rdp_group() {
        let schema = rdp_settings_schema();
        let keys: Vec<&str> = schema.groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, vec!["connection", "display", "features", "rdp"]);
    }

    #[test]
    fn schema_has_domain_field() {
        let schema = rdp_settings_schema();
        let has_domain = schema
            .groups
            .iter()
            .flat_map(|g| &g.fields)
            .any(|f| f.key == "domain");
        assert!(has_domain, "RDP must expose a domain field");
    }

    #[test]
    fn schema_has_security_mode_and_cert_toggle() {
        let schema = rdp_settings_schema();
        let group = schema.groups.iter().find(|g| g.key == "rdp").unwrap();
        assert!(group.fields.iter().any(|f| f.key == "securityMode"));
        assert!(group.fields.iter().any(|f| f.key == "ignoreCertErrors"));
    }

    #[test]
    fn schema_port_defaults_to_3389() {
        let schema = rdp_settings_schema();
        let port = schema.groups[0]
            .fields
            .iter()
            .find(|f| f.key == "port")
            .unwrap();
        assert_eq!(port.default, Some(serde_json::json!(3389)));
    }

    #[test]
    fn schema_serializes() {
        let schema = rdp_settings_schema();
        let json = serde_json::to_string(&schema).unwrap();
        let back: SettingsSchema = serde_json::from_str(&json).unwrap();
        assert_eq!(back.groups.len(), 4);
    }
}
