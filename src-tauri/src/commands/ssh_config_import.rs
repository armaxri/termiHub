//! Tauri command for importing a `ProxyJump` chain from the user's OpenSSH
//! client config (`~/.ssh/config`, plus any `Include`d files) into the
//! first-class jump-host editor (#1702).
//!
//! This reads the OpenSSH *client* config — distinct from termiHub's own
//! `config`/`ssh_config` modules — enumerates the `Host` stanzas that declare a
//! `ProxyJump`, resolves each hop against its own `Host` stanza
//! (`Hostname`/`User`/`Port`/`IdentityFile`), and returns the chain as
//! [`JumpHostConfig`]-shaped data the editor can drop straight into a
//! connection's `proxyJump` array. It never creates connections: the frontend
//! only pre-populates the editor fields, which the user reviews before saving.
//!
//! Parsing is delegated to the maintained [`ssh2_config`] crate (library-first
//! per the repo rules) rather than hand-rolling the tokenizer / `Include` /
//! `Match` semantics.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;

use termihub_core::config::JumpHostConfig;

use crate::utils::errors::TerminalError;

/// A host stanza from `~/.ssh/config` that declares a `ProxyJump`, offered to
/// the editor as an importable jump-host chain.
///
/// `name` is the `Host` alias (what the user typed as the SSH connection name);
/// `proxy_jump` is the ordered, resolved hop chain (outermost → innermost,
/// matching the shipped chain order).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportableHost {
    pub name: String,
    pub proxy_jump: Vec<JumpHostConfig>,
}

/// Default OpenSSH client-config path: `~/.ssh/config`
/// (`%USERPROFILE%\.ssh\config` on Windows). `None` when no home dir resolves.
fn default_ssh_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Parse the OpenSSH client config at `path` and return the host stanzas that
/// declare an importable `ProxyJump` chain.
///
/// A missing file is not an error — it yields an empty list (the friendly empty
/// state). A genuine parse failure returns `Err`; the command layer degrades
/// that to an empty list as well so the UI never shows an error toast.
pub fn parse_ssh_config_hosts(_path: &Path) -> Result<Vec<ImportableHost>, String> {
    // Implemented in the follow-up feat commit.
    Ok(Vec::new())
}

/// Read the default `~/.ssh/config` and return its importable jump-host chains.
///
/// Missing / empty / unparseable config all degrade to an empty list — the
/// picker shows a friendly empty state and never crashes or toasts.
#[tauri::command]
pub fn import_ssh_config_hosts() -> Result<Vec<ImportableHost>, TerminalError> {
    let Some(path) = default_ssh_config_path() else {
        return Ok(Vec::new());
    };
    Ok(parse_ssh_config_hosts(&path).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// Write `contents` to `<dir>/<name>` and return the full path.
    fn write_file(dir: &TempDir, name: &str, contents: &str) -> PathBuf {
        let path = dir.path().join(name);
        let mut f = File::create(&path).expect("create fixture");
        f.write_all(contents.as_bytes()).expect("write fixture");
        path
    }

    #[test]
    fn missing_file_yields_empty_list() {
        let missing = Path::new("/nonexistent/does/not/exist/ssh_config");
        assert_eq!(parse_ssh_config_hosts(missing).unwrap(), Vec::new());
    }

    #[test]
    fn single_hop_resolves_hostname_user_and_port() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host target
    HostName target.internal
    User alice
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    User bob
    Port 2222
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let target = hosts
            .iter()
            .find(|h| h.name == "target")
            .expect("target host present");
        assert_eq!(target.proxy_jump.len(), 1);
        let hop = &target.proxy_jump[0];
        assert_eq!(hop.host, "bastion.example.com");
        assert_eq!(hop.username, "bob");
        assert_eq!(hop.port, 2222);
    }

    #[test]
    fn multi_hop_preserves_outer_to_inner_order() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host target
    ProxyJump edge,bastion

Host edge
    HostName edge.example.com
    User e

Host bastion
    HostName bastion.example.com
    User b
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let target = hosts.iter().find(|h| h.name == "target").unwrap();
        assert_eq!(target.proxy_jump.len(), 2);
        assert_eq!(target.proxy_jump[0].host, "edge.example.com");
        assert_eq!(target.proxy_jump[1].host, "bastion.example.com");
    }

    #[test]
    fn proxy_jump_none_is_excluded() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host direct
    HostName direct.example.com
    ProxyJump none
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        assert!(
            !hosts.iter().any(|h| h.name == "direct"),
            "a `ProxyJump none` host must not be importable"
        );
    }

    #[test]
    fn identity_file_maps_to_key_auth() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host target
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    IdentityFile /home/me/.ssh/id_bastion
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let hop = &hosts.iter().find(|h| h.name == "target").unwrap().proxy_jump[0];
        assert_eq!(hop.auth_method, "key");
        assert_eq!(hop.key_path.as_deref(), Some("/home/me/.ssh/id_bastion"));
    }

    #[test]
    fn wildcard_and_negated_host_patterns_are_skipped() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host *.example.com !secret.example.com
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        assert!(
            hosts.is_empty(),
            "wildcard/negated patterns are not concrete importable hosts"
        );
    }

    #[test]
    fn include_pulls_hosts_from_referenced_file() {
        let dir = TempDir::new().unwrap();
        let included = write_file(
            &dir,
            "included.conf",
            "\
Host target
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    User b
",
        );
        // An absolute Include path is opened as-is by the parser.
        let path = write_file(&dir, "config", &format!("Include {}\n", included.display()));

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let target = hosts.iter().find(|h| h.name == "target");
        assert!(target.is_some(), "host from Included file must appear");
        assert_eq!(target.unwrap().proxy_jump[0].host, "bastion.example.com");
    }

    #[test]
    fn hop_without_own_stanza_falls_back_to_alias() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host target
    ProxyJump lonelybastion
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let hop = &hosts.iter().find(|h| h.name == "target").unwrap().proxy_jump[0];
        assert_eq!(hop.host, "lonelybastion");
        assert_eq!(hop.port, 22);
    }

    #[test]
    fn inline_user_and_port_in_proxyjump_spec_win() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host target
    ProxyJump carol@bastion:2201

Host bastion
    HostName bastion.example.com
    User ignored
    Port 22
",
        );

        let hosts = parse_ssh_config_hosts(&path).unwrap();
        let hop = &hosts.iter().find(|h| h.name == "target").unwrap().proxy_jump[0];
        assert_eq!(hop.host, "bastion.example.com");
        assert_eq!(hop.username, "carol");
        assert_eq!(hop.port, 2201);
    }
}
