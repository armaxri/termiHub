//! Import saved sessions from a MobaXterm configuration (#4850).
//!
//! Reads `MobaXterm.ini` (or a `.mxtsessions` export, which has the same
//! bookmark sections), maps each saved session onto a termiHub connection type
//! and returns a **preview**. Like the `~/.ssh/config` and inventory importers
//! ([`ssh_config_import`](super::ssh_config_import),
//! [`inventory_import`](super::inventory_import)) it never creates connections
//! itself: the frontend shows the preview, lets the user select sessions, and
//! persists the chosen ones through the normal folder/connection commands.
//!
//! - `parser` — decoding (UTF-8 / Windows-1252) and the bookmark-section split.
//! - `mapping` — session type → termiHub connection settings, skip reasons.
//! - `appearance` — the per-session terminal block (font, cursor, terminal
//!   type, session logging, scrollback) → per-connection terminal options
//!   (#4854, #4881).
//! - `global_appearance` — the global `[Colors]`, `[Font]` and `[Cursor]`
//!   sections, offered as an opt-in custom theme and appearance settings
//!   (#4880).
//! - `placeholders` — `_ProfileDir_`-style path tokens in key paths.
//! - `discovery` — where MobaXterm keeps its configuration on Windows.
//! - `hostkeys` — `[SSH_Hostkeys]` (PuTTY cache format) → OpenSSH keys (#4852).
//! - `trusted_hosts` — classify those keys against termiHub's SSH trust store
//!   and import the user-approved ones into it.
//!
//! Passwords are never imported: MobaXterm keeps them in its own encrypted
//! vault, which termiHub does not read.

mod appearance;
mod discovery;
mod global_appearance;
mod hostkeys;
mod mapping;
mod parser;
mod placeholders;
mod trusted_hosts;

#[cfg(test)]
mod appearance_tests;
#[cfg(test)]
mod global_appearance_tests;
#[cfg(test)]
mod hostkeys_tests;
#[cfg(test)]
mod logging_scrollback_tests;
#[cfg(test)]
mod tests;

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::connection::config::TerminalOptions;
use crate::session::ssh_host_key_verifier::SshHostKeyVerifier;
use crate::utils::errors::TerminalError;

use global_appearance::{parse_global_appearance, MobaxtermGlobalAppearance};
use mapping::{map_session, Outcome};
use placeholders::PlaceholderEnv;
use trusted_hosts::{host_key_entries, import_host_keys, StoreTrust, TrustCheck};
pub use trusted_hosts::{HostKeyImportResult, HostKeySelection, MobaxtermHostKey};

/// Refuse files larger than this: a real MobaXterm.ini is tens of kilobytes,
/// so anything this big is not one (and must not be read into memory whole).
const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;

/// A MobaXterm configuration found on this machine.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermConfigCandidate {
    /// Absolute path of the configuration file.
    pub path: String,
    /// `"installed"` (`%APPDATA%\MobaXterm`) or `"documents"`.
    pub source: String,
}

/// One saved MobaXterm session in the import preview.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermSession {
    /// Stable key for selection, unique within one preview.
    pub key: String,
    /// The session's display name in MobaXterm.
    pub name: String,
    /// MobaXterm folder path, outermost first; empty for the root.
    pub folder_path: Vec<String>,
    /// MobaXterm session type label (`"SSH"`, `"Serial"`, `"Browser"`, …).
    pub session_type: String,
    /// One-line target summary (`user@host:port`, `COM3 @ 9600`); may be empty.
    pub target: String,
    /// termiHub connection type to create; absent when the session is skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub connection_type: Option<String>,
    /// Settings for the new connection (schema keys of `connection_type`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional, type = "Record<string, unknown>"))]
    pub settings: Option<serde_json::Value>,
    /// Why the session cannot be imported; absent for importable sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub skip_reason: Option<String>,
    /// Per-connection terminal options (font, cursor) from the session's
    /// MobaXterm terminal settings; absent when nothing was mappable (#4854).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub terminal_options: Option<TerminalOptions>,
    /// Settings that were not carried over, or assumptions that were made.
    pub notes: Vec<String>,
}

/// The parsed contents of a MobaXterm configuration, ready for preview.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MobaxtermImportPreview {
    /// The file that was read.
    pub source_path: String,
    /// `"utf-8"` or `"windows-1252"`.
    pub encoding: String,
    /// Every saved session, importable and skipped, in file order.
    pub sessions: Vec<MobaxtermSession>,
    /// Every `[SSH_Hostkeys]` entry, importable and skipped, in file order.
    pub host_keys: Vec<MobaxtermHostKey>,
    /// MobaXterm's global colours, font and cursor (#4880), parsed but not
    /// applied: the dialog offers them behind explicit opt-ins. Absent when
    /// the file has nothing usable in those sections.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub global_appearance: Option<MobaxtermGlobalAppearance>,
    /// File-level remarks, e.g. global appearance values that could not be
    /// read or have no termiHub counterpart.
    pub notes: Vec<String>,
}

/// Build the preview from raw file bytes, with every host key classified as
/// new (no trust store consulted). Used by the tests.
#[cfg(test)]
pub fn preview_from_bytes(
    bytes: &[u8],
    source_path: &str,
    env: &PlaceholderEnv,
) -> MobaxtermImportPreview {
    preview_with_trust(bytes, source_path, env, &trusted_hosts::NothingTrusted)
}

/// Build the preview from raw file bytes, classifying host keys with `trust`.
pub fn preview_with_trust(
    bytes: &[u8],
    source_path: &str,
    env: &PlaceholderEnv,
    trust: &dyn TrustCheck,
) -> MobaxtermImportPreview {
    let (text, encoding) = parser::decode(bytes);
    let host_keys = host_key_entries(&text, trust);
    let sessions = parser::parse_bookmarks(&text)
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let mapped = map_session(raw, env);
            let (connection_type, settings, skip_reason) = match mapped.outcome {
                Outcome::Import {
                    connection_type,
                    settings,
                } => (Some(connection_type.to_string()), Some(settings), None),
                Outcome::Skip(reason) => (None, None, Some(reason)),
            };
            MobaxtermSession {
                key: format!("moba-{i}"),
                name: if raw.name.is_empty() {
                    format!("{} session", mapped.session_type)
                } else {
                    raw.name.clone()
                },
                folder_path: raw.folder_path.clone(),
                session_type: mapped.session_type,
                target: mapped.target,
                connection_type,
                settings,
                skip_reason,
                terminal_options: mapped.terminal_options,
                notes: mapped.notes,
            }
        })
        .collect();
    let mut notes = Vec::new();
    let global_appearance = parse_global_appearance(&text, &mut notes);
    MobaxtermImportPreview {
        source_path: source_path.to_string(),
        encoding: encoding.label().to_string(),
        sessions,
        host_keys,
        global_appearance,
        notes,
    }
}

/// Read a configuration file, refusing non-files and oversized files.
fn read_config(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "{} is too large to be a MobaXterm configuration",
            path.display()
        ));
    }
    std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// Read and preview the MobaXterm configuration at `path`.
pub fn preview_file(
    path: &Path,
    env: &PlaceholderEnv,
    trust: &dyn TrustCheck,
) -> Result<MobaxtermImportPreview, String> {
    let bytes = read_config(path)?;
    Ok(preview_with_trust(
        &bytes,
        &path.to_string_lossy(),
        env,
        trust,
    ))
}

/// List the MobaXterm configurations found on this machine. Always empty off
/// Windows; never fails — a missing or unreadable location just isn't listed.
#[tauri::command]
pub fn discover_mobaxterm_configs() -> Result<Vec<MobaxtermConfigCandidate>, TerminalError> {
    Ok(discovery::discover()
        .into_iter()
        .map(|(path, source)| MobaxtermConfigCandidate {
            path: path.to_string_lossy().into_owned(),
            source: source.label().to_string(),
        })
        .collect())
}

/// Parse the MobaXterm configuration (`MobaXterm.ini` or `.mxtsessions`) at
/// `path` into an import preview. The user picked or confirmed this file, so a
/// read failure is an error the UI shows.
///
/// Host keys are classified against termiHub's SSH trust store and the user's
/// `~/.ssh/known_hosts`; nothing is trusted until
/// [`import_mobaxterm_host_keys`] is called with the user's opt-in.
#[tauri::command]
pub fn preview_mobaxterm_import(
    path: String,
    verifier: State<'_, Arc<SshHostKeyVerifier>>,
) -> Result<MobaxtermImportPreview, TerminalError> {
    let trust = StoreTrust::new(verifier.trust_store());
    preview_file(Path::new(&path), &PlaceholderEnv::from_system(), &trust)
        .map_err(TerminalError::InvalidParams)
}

/// Trust the host keys the user opted in to importing from the MobaXterm
/// configuration at `path` (#4852).
///
/// The file is re-read and every selected entry re-validated and re-classified
/// here, so only a key that is still valid, still has the fingerprint the user
/// saw in the preview, and still has no conflicting trusted key is added. An
/// existing entry is never replaced or extended with a different key.
#[tauri::command]
pub fn import_mobaxterm_host_keys(
    path: String,
    selections: Vec<HostKeySelection>,
    verifier: State<'_, Arc<SshHostKeyVerifier>>,
) -> Result<HostKeyImportResult, TerminalError> {
    let bytes = read_config(Path::new(&path)).map_err(TerminalError::InvalidParams)?;
    let (text, _) = parser::decode(&bytes);
    let store = verifier.trust_store();
    Ok(import_host_keys(
        &text,
        &selections,
        store,
        &StoreTrust::new(store),
    ))
}
