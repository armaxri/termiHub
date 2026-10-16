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
//! - `placeholders` — `_ProfileDir_`-style path tokens in key paths.
//! - `discovery` — where MobaXterm keeps its configuration on Windows.
//!
//! Passwords are never imported: MobaXterm keeps them in its own encrypted
//! vault, which termiHub does not read.

mod discovery;
mod mapping;
mod parser;
mod placeholders;

#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;

use crate::utils::errors::TerminalError;

use mapping::{map_session, Outcome};
use placeholders::PlaceholderEnv;

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
}

/// Build the preview from raw file bytes. Shared by the command and the tests.
pub fn preview_from_bytes(
    bytes: &[u8],
    source_path: &str,
    env: &PlaceholderEnv,
) -> MobaxtermImportPreview {
    let (text, encoding) = parser::decode(bytes);
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
                notes: mapped.notes,
            }
        })
        .collect();
    MobaxtermImportPreview {
        source_path: source_path.to_string(),
        encoding: encoding.label().to_string(),
        sessions,
    }
}

/// Read and preview the MobaXterm configuration at `path`.
pub fn preview_file(path: &Path, env: &PlaceholderEnv) -> Result<MobaxtermImportPreview, String> {
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
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(preview_from_bytes(&bytes, &path.to_string_lossy(), env))
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
#[tauri::command]
pub fn preview_mobaxterm_import(path: String) -> Result<MobaxtermImportPreview, TerminalError> {
    preview_file(Path::new(&path), &PlaceholderEnv::from_system())
        .map_err(TerminalError::InvalidParams)
}
