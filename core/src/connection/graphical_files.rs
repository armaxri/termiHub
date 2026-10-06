//! File transfer over a graphical session's **side channel** (#3770, #4191).
//!
//! VNC has no portable RFB file-transfer extension, so files move over the
//! carrier the connection already has instead of over RFB:
//!
//! - **SSH tunnel** — an SFTP subsystem channel opened on the tunnel's own
//!   authenticated SSH session (no second login; the host key was already
//!   verified by the tunnel's trust flow). The file host is the SSH host.
//! - **Agent** (#3241 port forward) — the agent's host-level
//!   `connection.files.*` calls (no `connection_id`). The file host is the
//!   agent host.
//! - **Direct** — no route; the feature is unavailable.
//!
//! When both apply, the agent wins: the tunnel would then run from the agent
//! host, and the agent already owns the file service. The feature is **off by
//! default** per connection and refused in **view-only** sessions; both rules
//! are enforced by the backend, not only the UI.
//!
//! This module holds the protocol-blind, pure parts of that contract — the
//! types exported to the frontend, the same-host check and route precedence,
//! and the default-folder rule — so they are unit-testable without a live
//! session. The live halves (the VNC tunnel's SSH session, the agent RPCs) are
//! wired by the backend and the desktop's graphical session manager.

use std::net::IpAddr;

use serde::{Deserialize, Serialize};

/// How files reach the side-channel host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum FileSideChannelKind {
    /// SFTP on the VNC SSH tunnel's own session.
    Ssh,
    /// The hosting agent's host-level `connection.files.*` service.
    Agent,
}

/// The resolved side channel of a graphical session: where files go and how.
///
/// `host` is always the host the bytes actually land on (the SSH or agent
/// host) — never the desktop host when the two differ. `same_host` tells the
/// UI whether it may call that host "the desktop host" or must warn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub struct FileSideChannel {
    /// The carrier.
    pub kind: FileSideChannelKind,
    /// The file host: the SSH tunnel host or the agent host.
    pub host: String,
    /// The account files are written as on `host` (empty when unknown).
    pub user: String,
    /// Whether `host` is the desktop host: the VNC target, as seen from `host`,
    /// is loopback or has the same name as `host`.
    pub same_host: bool,
}

/// Why a graphical session has no usable file side channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = "../../src/types/generated/"))]
#[serde(rename_all = "camelCase")]
pub enum FileChannelUnavailable {
    /// The connection's "Allow file transfer" setting is off (the default).
    Disabled,
    /// The session is view-only: files are refused in both directions.
    ViewOnly,
    /// Neither an SSH tunnel nor an agent carries this connection (direct VNC),
    /// or the backend type has no side channel at all.
    NoRoute,
}

/// The per-connection policy inputs of route resolution.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FileChannelPolicy {
    /// The connection's `fileTransfer` opt-in.
    pub file_transfer: bool,
    /// The connection's `viewOnly` flag.
    pub view_only: bool,
}

impl FileChannelPolicy {
    /// Read the policy from a connection's settings JSON (`fileTransfer`,
    /// `viewOnly`). Missing or non-boolean values mean `false`, so a connection
    /// saved before #4191 stays opted out.
    pub fn from_settings(settings: &serde_json::Value) -> Self {
        let flag = |key: &str| {
            settings
                .get(key)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        };
        Self {
            file_transfer: flag("fileTransfer"),
            view_only: flag("viewOnly"),
        }
    }

    /// The refusal this policy imposes regardless of route, if any. An opted-out
    /// connection reports [`FileChannelUnavailable::Disabled`] before a
    /// view-only one reports [`FileChannelUnavailable::ViewOnly`].
    pub fn refusal(self) -> Option<FileChannelUnavailable> {
        if !self.file_transfer {
            Some(FileChannelUnavailable::Disabled)
        } else if self.view_only {
            Some(FileChannelUnavailable::ViewOnly)
        } else {
            None
        }
    }
}

/// Resolve a session's side channel from its policy and the candidate routes.
///
/// The policy refusals come first (off → `Disabled`, view-only → `ViewOnly`);
/// then the agent route wins over the SSH tunnel; with neither the result is
/// `NoRoute`.
pub fn resolve_file_side_channel(
    policy: FileChannelPolicy,
    agent: Option<FileSideChannel>,
    ssh: Option<FileSideChannel>,
) -> Result<FileSideChannel, FileChannelUnavailable> {
    if let Some(refusal) = policy.refusal() {
        return Err(refusal);
    }
    agent.or(ssh).ok_or(FileChannelUnavailable::NoRoute)
}

/// Strip IPv6 brackets and surrounding whitespace from a host string.
fn bare_host(host: &str) -> &str {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// Whether `host` names the loopback interface: `localhost` (any case, also
/// the `*.localhost` names RFC 6761 reserves for loopback), `127.0.0.0/8`, or
/// `::1` (bracketed or not).
pub fn is_loopback_host(host: &str) -> bool {
    let host = bare_host(host).trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if host.len() > ".localhost".len()
        && host
            .get(host.len() - ".localhost".len()..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(".localhost"))
    {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// Whether `file_host` counts as the desktop host for a VNC target named
/// `target` **as seen from `file_host`**: the target is loopback there, or has
/// the same name as `file_host` (case-insensitive).
pub fn is_same_host(target: &str, file_host: &str) -> bool {
    if is_loopback_host(target) {
        return true;
    }
    let target = bare_host(target).trim_end_matches('.');
    let file_host = bare_host(file_host).trim_end_matches('.');
    !target.is_empty() && target.eq_ignore_ascii_case(file_host)
}

/// Join a remote directory and a child name with `/` (SFTP and the agent both
/// report `/`-separated paths, including for Windows hosts).
fn join_remote(dir: &str, child: &str) -> String {
    let dir = dir.trim_end_matches('/');
    if dir.is_empty() {
        format!("/{child}")
    } else {
        format!("{dir}/{child}")
    }
}

/// Expand a configured default folder against the remote `home`: `~` is home,
/// `~/x` is under home, a relative path is under home, and an absolute path
/// (`/…`, or a Windows drive path) is kept as is. Returns `None` for an empty
/// (unset) value.
pub fn expand_remote_dir(configured: &str, home: &str) -> Option<String> {
    let configured = configured.trim();
    if configured.is_empty() {
        return None;
    }
    if configured == "~" {
        return Some(home.to_string());
    }
    if let Some(rest) = configured
        .strip_prefix("~/")
        .or_else(|| configured.strip_prefix("~\\"))
    {
        return Some(join_remote(home, rest));
    }
    let is_drive_path = configured.as_bytes().get(1) == Some(&b':');
    if configured.starts_with('/') || configured.starts_with('\\') || is_drive_path {
        return Some(configured.to_string());
    }
    Some(join_remote(home, configured))
}

/// The remote `~/Desktop` path for `home`.
pub fn desktop_dir(home: &str) -> String {
    join_remote(home, "Desktop")
}

/// The default destination folder: the connection's configured folder when
/// set, else `~/Desktop` when it exists, else `~`.
pub fn default_dir(configured: Option<&str>, home: &str, desktop_exists: bool) -> String {
    if let Some(dir) = configured.and_then(|c| expand_remote_dir(c, home)) {
        return dir;
    }
    if desktop_exists {
        desktop_dir(home)
    } else {
        home.to_string()
    }
}

#[cfg(test)]
#[path = "graphical_files_tests.rs"]
mod tests;
