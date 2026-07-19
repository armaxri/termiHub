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
use ssh2_config::{ParseRule, SshConfig};

use termihub_core::config::JumpHostConfig;

use crate::utils::errors::TerminalError;

/// A host stanza from `~/.ssh/config` that declares a `ProxyJump`, offered to
/// the editor as an importable jump-host chain.
///
/// `name` is the `Host` alias (what the user typed as the SSH connection name);
/// `proxy_jump` is the ordered, resolved hop chain (outermost → innermost,
/// matching the shipped chain order).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableHost {
    pub name: String,
    pub proxy_jump: Vec<JumpHostConfig>,
}

/// A whole SSH connection resolved from a `~/.ssh/config` `Host` stanza (#1722),
/// offered to the connection editor to pre-populate a new SSH connection.
///
/// Unlike [`ImportableHost`] (which carries only a jump-host chain), this is the
/// *target* connection: `name` is the `Host` alias, and the remaining fields are
/// the resolved `Hostname`/`Port`/`User`/`IdentityFile` plus the target's own
/// resolved `ProxyJump` chain (empty for a direct connection). The frontend
/// drops these straight into the editor's SSH fields, which the user reviews and
/// edits before saving.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportableConnection {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `"key"` when an `IdentityFile` is configured, otherwise `"agent"`
    /// (mirrors the jump-host import's auth mapping).
    pub auth_method: String,
    pub key_path: Option<String>,
    pub proxy_jump: Vec<JumpHostConfig>,
}

/// The concrete target params resolved from a single `Host` stanza's own
/// directives (`Hostname`/`Port`/`User`/`IdentityFile`), with OpenSSH's
/// fallbacks applied. Shared by the target-connection importer and the per-hop
/// resolver so both agree on how a stanza dereferences.
struct ResolvedTarget {
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    key_path: Option<String>,
}

/// Default OpenSSH client-config path: `~/.ssh/config`
/// (`%USERPROFILE%\.ssh\config` on Windows). `None` when no home dir resolves.
fn default_ssh_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("config"))
}

/// Parse the OpenSSH client config at `path`, or `Ok(None)` when the file does
/// not exist (the friendly empty state — a missing config is not an error).
///
/// A genuine parse failure returns `Err`; the callers degrade that to an empty
/// list at the command layer so the UI never shows an error toast.
fn parse_config(path: &Path) -> Result<Option<SshConfig>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut reader = BufReader::new(file);
    // Permissive parsing: a real `~/.ssh/config` routinely carries directives
    // ssh2-config doesn't model. STRICT would reject the whole file, so allow
    // unknown/unsupported fields and simply ignore them.
    let config = SshConfig::default()
        .parse(
            &mut reader,
            ParseRule::ALLOW_UNKNOWN_FIELDS | ParseRule::ALLOW_UNSUPPORTED_FIELDS,
        )
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    Ok(Some(config))
}

/// Parse the OpenSSH client config at `path` and return the host stanzas that
/// declare an importable `ProxyJump` chain.
///
/// A missing file is not an error — it yields an empty list (the friendly empty
/// state). A genuine parse failure returns `Err`; the command layer degrades
/// that to an empty list as well so the UI never shows an error toast.
pub fn parse_ssh_config_hosts(path: &Path) -> Result<Vec<ImportableHost>, String> {
    Ok(parse_config(path)?
        .as_ref()
        .map(extract_importable_hosts)
        .unwrap_or_default())
}

/// Parse the OpenSSH client config at `path` and return every concrete `Host`
/// alias as a whole, importable SSH connection (#1722) — direct hosts and hosts
/// behind a `ProxyJump` alike. Missing / unparseable config degrades exactly as
/// [`parse_ssh_config_hosts`] does.
pub fn parse_ssh_config_connections(path: &Path) -> Result<Vec<ImportableConnection>, String> {
    Ok(parse_config(path)?
        .as_ref()
        .map(extract_importable_connections)
        .unwrap_or_default())
}

/// A host pattern is a concrete, importable alias only when it is neither a
/// wildcard (`*`/`?`) nor a `Match`-style token — i.e. a literal host name the
/// user could type as a connection.
fn is_concrete_alias(pattern: &str) -> bool {
    !pattern.is_empty() && !pattern.contains('*') && !pattern.contains('?')
}

/// Walk the parsed config's `Host` stanzas and turn each one that declares a
/// usable `ProxyJump` into an [`ImportableHost`] (one per concrete alias in the
/// stanza). Wildcard/negated patterns and `ProxyJump none` are skipped.
fn extract_importable_hosts(config: &SshConfig) -> Vec<ImportableHost> {
    let mut out = Vec::new();
    for host in config.get_hosts() {
        let proxy = match host.params.proxy_jump.as_ref() {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        // `ProxyJump none` explicitly disables jumping — nothing to import.
        if proxy.len() == 1 && proxy[0].eq_ignore_ascii_case("none") {
            continue;
        }
        let hops: Vec<JumpHostConfig> =
            proxy.iter().map(|spec| resolve_hop(config, spec)).collect();
        for clause in &host.pattern {
            if clause.negated || !is_concrete_alias(&clause.pattern) {
                continue;
            }
            out.push(ImportableHost {
                name: clause.pattern.clone(),
                proxy_jump: hops.clone(),
            });
        }
    }
    out
}

/// Dereference a config `alias`'s own stanza into concrete target params,
/// applying OpenSSH's fallbacks: a missing `Hostname` falls back to the alias
/// itself, a missing `Port` to 22, and `IdentityFile` → `key` auth (else the
/// `agent` default, the usual bastion setup — the user can change it after
/// import). Shared by the whole-connection importer and the per-hop resolver.
fn resolve_target(config: &SshConfig, alias: &str) -> ResolvedTarget {
    let params = config.query(alias);
    let host = params
        .host_name
        .clone()
        .unwrap_or_else(|| alias.to_string());
    let port = params.port.unwrap_or(22);
    let username = params.user.unwrap_or_default();
    let (auth_method, key_path) = match params.identity_file.as_ref().and_then(|f| f.first()) {
        Some(path) => ("key".to_string(), Some(path.to_string_lossy().into_owned())),
        None => ("agent".to_string(), None),
    };
    ResolvedTarget {
        host,
        port,
        username,
        auth_method,
        key_path,
    }
}

/// Resolve a single `ProxyJump` spec (`[user@]host[:port]`) into a
/// [`JumpHostConfig`], dereferencing the hop's own `Host` stanza for the real
/// `Hostname`/`User`/`Port`/`IdentityFile`. Inline `user@`/`:port` in the spec
/// take precedence over the stanza, matching OpenSSH.
fn resolve_hop(config: &SshConfig, spec: &str) -> JumpHostConfig {
    let (inline_user, host_port) = match spec.split_once('@') {
        Some((user, rest)) => (Some(user.to_string()), rest),
        None => (None, spec),
    };
    // Split a trailing `:port` only when it parses as a port — leaves bare hosts
    // and (best-effort) bracketed IPv6 literals intact.
    let (alias, inline_port) = match host_port.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h, Some(port)),
            Err(_) => (host_port, None),
        },
        None => (host_port, None),
    };

    let target = resolve_target(config, alias);
    // Inline `user@`/`:port` from the spec win over the stanza, matching OpenSSH.
    let port = inline_port.unwrap_or(target.port);
    let username = inline_user.unwrap_or(target.username);

    JumpHostConfig {
        connection_id: None,
        host: target.host,
        port,
        username,
        auth_method: target.auth_method,
        password: None,
        key_path: target.key_path,
        connect_timeout_secs: None,
    }
}

/// Resolve a target host's own `ProxyJump` chain (empty for a direct
/// connection), applying the same skip rules as the chain importer: an absent
/// or empty `ProxyJump`, or an explicit `ProxyJump none`, yields no hops.
fn resolve_target_proxy_jump(
    config: &SshConfig,
    params: &ssh2_config::HostParams,
) -> Vec<JumpHostConfig> {
    let proxy = match params.proxy_jump.as_ref() {
        Some(p) if !p.is_empty() => p,
        _ => return Vec::new(),
    };
    if proxy.len() == 1 && proxy[0].eq_ignore_ascii_case("none") {
        return Vec::new();
    }
    proxy.iter().map(|spec| resolve_hop(config, spec)).collect()
}

/// Walk the parsed config's `Host` stanzas and turn each concrete alias into a
/// whole, importable [`ImportableConnection`] — direct hosts and hosts behind a
/// `ProxyJump` alike. Wildcard/negated patterns (`*`, `?`, `!host`, `Match`) are
/// skipped, mirroring the chain importer.
fn extract_importable_connections(config: &SshConfig) -> Vec<ImportableConnection> {
    let mut out = Vec::new();
    for host in config.get_hosts() {
        let proxy_jump = resolve_target_proxy_jump(config, &host.params);
        for clause in &host.pattern {
            if clause.negated || !is_concrete_alias(&clause.pattern) {
                continue;
            }
            let target = resolve_target(config, &clause.pattern);
            out.push(ImportableConnection {
                name: clause.pattern.clone(),
                host: target.host,
                port: target.port,
                username: target.username,
                auth_method: target.auth_method,
                key_path: target.key_path,
                proxy_jump: proxy_jump.clone(),
            });
        }
    }
    out
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

/// Read the default `~/.ssh/config` and return every concrete `Host` alias as a
/// whole, importable SSH connection (#1722).
///
/// Missing / empty / unparseable config all degrade to an empty list — the
/// picker shows a friendly empty state and never crashes or toasts.
#[tauri::command]
pub fn import_ssh_config_connections() -> Result<Vec<ImportableConnection>, TerminalError> {
    let Some(path) = default_ssh_config_path() else {
        return Ok(Vec::new());
    };
    Ok(parse_ssh_config_connections(&path).unwrap_or_default())
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
        assert!(parse_ssh_config_hosts(missing).unwrap().is_empty());
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
        let hop = &hosts
            .iter()
            .find(|h| h.name == "target")
            .unwrap()
            .proxy_jump[0];
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

    // Unix-only: this fixture points `Include` at an absolute temp-dir path.
    // ssh2-config's `resolve_include_path` treats a path as absolute only when it
    // starts with the platform separator (`\` on Windows), so a Windows temp path
    // (`C:\...` or `C:/...`) is misclassified as *relative* and resolved against
    // the real `$HOME\.ssh`, never finding the fixture. There is no portable way
    // to express an absolute temp Include path the crate accepts on Windows, and
    // `dirs::home_dir()` on Windows ignores env vars (Known Folder API), so the
    // real home can't be redirected under test either. Include *resolution* is the
    // crate's own (Windows-tested) code; here we only verify termiHub consumes the
    // included hosts, which the Unix run covers. Windows include-path behaviour is
    // tracked as a follow-up.
    #[cfg(unix)]
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
        // On Unix the absolute temp path starts with `/`, so ssh2-config opens it
        // directly (see the module-level note above for the Windows limitation).
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
        let hop = &hosts
            .iter()
            .find(|h| h.name == "target")
            .unwrap()
            .proxy_jump[0];
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
        let hop = &hosts
            .iter()
            .find(|h| h.name == "target")
            .unwrap()
            .proxy_jump[0];
        assert_eq!(hop.host, "bastion.example.com");
        assert_eq!(hop.username, "carol");
        assert_eq!(hop.port, 2201);
    }

    // ── Whole-connection import (#1722) ──────────────────────────────────────

    #[test]
    fn connections_missing_file_yields_empty_list() {
        let missing = Path::new("/nonexistent/does/not/exist/ssh_config");
        assert!(parse_ssh_config_connections(missing).unwrap().is_empty());
    }

    #[test]
    fn direct_host_resolves_hostname_user_port_without_proxy_jump() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host web
    HostName web.internal
    User alice
    Port 2022
",
        );

        let conns = parse_ssh_config_connections(&path).unwrap();
        let web = conns.iter().find(|c| c.name == "web").expect("web present");
        assert_eq!(web.host, "web.internal");
        assert_eq!(web.username, "alice");
        assert_eq!(web.port, 2022);
        assert!(
            web.proxy_jump.is_empty(),
            "a direct host has no jump-host chain"
        );
    }

    #[test]
    fn connection_with_proxy_jump_populates_resolved_chain() {
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

        let conns = parse_ssh_config_connections(&path).unwrap();
        let target = conns
            .iter()
            .find(|c| c.name == "target")
            .expect("target present");
        assert_eq!(target.host, "target.internal");
        assert_eq!(target.username, "alice");
        assert_eq!(target.proxy_jump.len(), 1);
        assert_eq!(target.proxy_jump[0].host, "bastion.example.com");
        assert_eq!(target.proxy_jump[0].username, "bob");
        assert_eq!(target.proxy_jump[0].port, 2222);
    }

    #[test]
    fn connection_identity_file_maps_to_key_auth() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host keyed
    HostName keyed.example.com
    IdentityFile /home/me/.ssh/id_keyed
",
        );

        let conns = parse_ssh_config_connections(&path).unwrap();
        let keyed = conns.iter().find(|c| c.name == "keyed").unwrap();
        assert_eq!(keyed.auth_method, "key");
        assert_eq!(keyed.key_path.as_deref(), Some("/home/me/.ssh/id_keyed"));
    }

    #[test]
    fn connection_without_identity_file_defaults_to_agent_auth() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host agentless
    HostName agentless.example.com
    User carol
",
        );

        let conns = parse_ssh_config_connections(&path).unwrap();
        let c = conns.iter().find(|c| c.name == "agentless").unwrap();
        assert_eq!(c.auth_method, "agent");
        assert!(c.key_path.is_none());
    }

    #[test]
    fn connection_missing_hostname_falls_back_to_alias_and_default_port() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host bare
    User dave
",
        );

        let conns = parse_ssh_config_connections(&path).unwrap();
        let bare = conns.iter().find(|c| c.name == "bare").unwrap();
        assert_eq!(bare.host, "bare");
        assert_eq!(bare.port, 22);
        assert_eq!(bare.username, "dave");
    }

    #[test]
    fn wildcard_and_negated_patterns_are_skipped_for_connections() {
        let dir = TempDir::new().unwrap();
        let path = write_file(
            &dir,
            "config",
            "\
Host *.example.com !secret.example.com
    User shared

Host concrete
    HostName concrete.example.com
",
        );

        let conns = parse_ssh_config_connections(&path).unwrap();
        assert!(
            conns.iter().all(|c| c.name == "concrete"),
            "only concrete aliases are importable connections"
        );
        assert_eq!(conns.len(), 1);
    }

    #[test]
    fn proxy_jump_none_yields_a_direct_importable_connection() {
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

        let conns = parse_ssh_config_connections(&path).unwrap();
        let direct = conns
            .iter()
            .find(|c| c.name == "direct")
            .expect("a `ProxyJump none` host is still importable as a direct connection");
        assert!(direct.proxy_jump.is_empty());
    }
}
