//! Which filesystem a session's file browser reaches (#5355).
//!
//! Two **different** sessions can reach one filesystem: two agent-hosted
//! local sessions on one agent host, two SSH sessions to one server as one
//! user, two sessions on one container. A paste between them of a file onto
//! itself would still truncate the source, because the same-session guards
//! of #5330 never see it as one end. A [`FilesystemId`] names what a session
//! reaches, so a cross-session paste can tell when both ends are the same
//! filesystem and run the same guard there.
//!
//! The identity is **conservative**: two ids are equal only when the ends
//! surely reach the same files. Anything the backend cannot tell (a browser
//! riding a borrowed SSH session, an agent-hosted session opened from a
//! saved definition with no inline config) has no id, and a paste between
//! ends without a matching id is never refused. A host name is compared as
//! spelled (ASCII case folded), so an alias and an IP of one server are two
//! ids: a missed match keeps today's behaviour, a false one would refuse a
//! legitimate copy between two hosts.

use crate::config::SshConfig;
use crate::files::FileEntry;

/// The filesystem a session's file browser reaches. Equal ids mean the two
/// sessions see the same files under the same paths.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FilesystemId {
    /// The desktop's own local filesystem.
    Local,
    /// An SSH server as one user sees it over SFTP.
    Ssh(SshServerId),
    /// An FTP server as one login sees it.
    Ftp {
        /// The server's host name, ASCII-lowercased.
        host: String,
        /// The control-channel port.
        port: u16,
        /// The login (`anonymous` for an anonymous login).
        user: String,
    },
    /// One Docker container.
    Docker {
        /// The container id.
        container_id: String,
    },
    /// A filesystem reached through an agent: what `backend` names, as the
    /// agent `agent_id` reaches it. [`FilesystemId::Local`] there is the
    /// agent host's own filesystem.
    Agent {
        /// The agent the sessions run on.
        agent_id: String,
        /// What the agent-side session browses.
        backend: Box<FilesystemId>,
    },
}

impl FilesystemId {
    /// The agent host's own filesystem, as an agent-hosted local session and
    /// the agent's host-level file service browse it.
    pub fn agent_host(agent_id: &str) -> Self {
        Self::Agent {
            agent_id: agent_id.to_string(),
            backend: Box::new(Self::Local),
        }
    }

    /// The SSH server of `config`, or `None` when it names none.
    pub fn ssh(config: &SshConfig) -> Option<Self> {
        SshServerId::of(config).map(Self::Ssh)
    }
}

/// Whether two ends that may have an identity surely reach one filesystem.
pub fn same_filesystem(a: Option<&FilesystemId>, b: Option<&FilesystemId>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a == b)
}

/// An SSH server, the user logged in to it and the route the connection
/// takes to reach it (jump hosts, an outbound proxy): the same host name
/// behind two different bastions can be two machines.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SshServerId {
    host: String,
    port: u16,
    user: String,
    route: Vec<String>,
}

impl SshServerId {
    /// The server `config` connects to, or `None` when it names no host or
    /// user (a browser riding a borrowed session has neither).
    pub fn of(config: &SshConfig) -> Option<Self> {
        if config.host.trim().is_empty() || config.username.is_empty() {
            return None;
        }
        let mut route: Vec<String> = config
            .proxy_jump
            .iter()
            .map(|hop| format!("{}@{}:{}", hop.username, host_key(&hop.host), hop.port))
            .collect();
        if let Some(proxy) = &config.proxy {
            route.push(format!(
                "{:?}://{}:{}",
                proxy.proxy_type,
                host_key(&proxy.host),
                proxy.port
            ));
        }
        Some(Self {
            host: host_key(&config.host),
            port: config.port,
            user: config.username.clone(),
            route,
        })
    }
}

/// A host name as compared: trimmed, ASCII case folded.
pub fn host_key(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

/// A weaker sign that two ends **may** reach one filesystem (#5430): the
/// same SSH server whatever the login, a loopback server under another of
/// its names, two agent-hosted SSH sessions opened from one saved
/// definition. Unlike a [`FilesystemId`], equal hints are not enough to
/// refuse a paste: the source must also show the same entry on both ends
/// ([`same_entry`]). A login can be jailed (`ChrootDirectory`), a name can
/// point elsewhere, a definition can be edited between two connects.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FilesystemHint {
    /// An SSH server reached on `port` over `route`, any login.
    Ssh {
        /// The host name, with the loopback names folded into one.
        host: String,
        /// The SSH port.
        port: u16,
        /// The jump hosts and proxy, as in [`SshServerId`].
        route: Vec<String>,
    },
    /// What `backend` hints at, as the agent `agent_id` reaches it.
    Agent {
        /// The agent the sessions run on.
        agent_id: String,
        /// The hosted session's hint.
        backend: Box<FilesystemHint>,
    },
    /// An agent-hosted SSH session opened from the saved definition
    /// `definition_id` on the agent `agent_id`.
    AgentDefinition {
        /// The agent the sessions run on.
        agent_id: String,
        /// The agent-side saved connection definition.
        definition_id: String,
    },
}

impl FilesystemHint {
    /// The SSH server of `config` whatever the login, or `None` when it
    /// names no host.
    pub fn ssh(config: &SshConfig) -> Option<Self> {
        if config.host.trim().is_empty() {
            return None;
        }
        let mut route: Vec<String> = config
            .proxy_jump
            .iter()
            .map(|hop| format!("{}@{}:{}", hop.username, hint_host(&hop.host), hop.port))
            .collect();
        if let Some(proxy) = &config.proxy {
            route.push(format!(
                "{:?}://{}:{}",
                proxy.proxy_type,
                hint_host(&proxy.host),
                proxy.port
            ));
        }
        Some(Self::Ssh {
            host: hint_host(&config.host),
            port: config.port,
            route,
        })
    }
}

/// A host name as a [`FilesystemHint`] compares it: [`host_key`], without
/// a trailing root dot, and every loopback spelling as `localhost`.
fn hint_host(host: &str) -> String {
    let key = host_key(host);
    let key = key.strip_suffix('.').unwrap_or(&key).to_string();
    let bare = key.trim_start_matches('[').trim_end_matches(']');
    let loopback = matches!(bare, "localhost" | "::1" | "0:0:0:0:0:0:0:1")
        || bare
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|ip| ip.is_loopback());
    if loopback {
        "localhost".to_string()
    } else {
        key
    }
}

/// How surely two ends of a cross-session paste reach one filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sharing {
    /// Equal [`FilesystemId`]s: the same path is the same entry.
    Surely,
    /// Equal [`FilesystemHint`]s only: refuse only when the source shows
    /// the same entry on both ends ([`same_entry`]).
    Possibly,
    /// Different or unknown: never refused.
    No,
}

/// How surely two ends with these identities and hints share a filesystem.
pub fn sharing(
    (id_a, id_b): (Option<&FilesystemId>, Option<&FilesystemId>),
    (hint_a, hint_b): (Option<&FilesystemHint>, Option<&FilesystemHint>),
) -> Sharing {
    if same_filesystem(id_a, id_b) {
        Sharing::Surely
    } else if matches!((hint_a, hint_b), (Some(a), Some(b)) if a == b) {
        Sharing::Possibly
    } else {
        Sharing::No
    }
}

/// Whether two `stat`s of one path, taken through two ends, show the same
/// entry (#5430): the same kind, modification time and permissions, and
/// for a file the same size. A backend that reports no modification time
/// or no permissions never matches, so an end that cannot show an entry
/// is never taken for the other's.
pub fn same_entry(a: &FileEntry, b: &FileEntry) -> bool {
    a.is_directory == b.is_directory
        && !a.modified.is_empty()
        && a.modified == b.modified
        && a.permissions.is_some()
        && a.permissions == b.permissions
        && (a.is_directory || a.size == b.size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::JumpHostConfig;

    fn ssh(host: &str, port: u16, user: &str) -> SshConfig {
        SshConfig {
            host: host.to_string(),
            port,
            username: user.to_string(),
            auth_method: "password".to_string(),
            ..SshConfig::default()
        }
    }

    #[test]
    fn one_server_and_user_is_one_filesystem() {
        let a = FilesystemId::ssh(&ssh("Build.example", 22, "ci"));
        let b = FilesystemId::ssh(&ssh("build.example ", 22, "ci"));
        assert!(same_filesystem(a.as_ref(), b.as_ref()));
    }

    #[test]
    fn another_port_user_or_host_is_another_filesystem() {
        let a = FilesystemId::ssh(&ssh("build.example", 22, "ci"));
        for other in [
            ssh("build.example", 2222, "ci"),
            ssh("build.example", 22, "root"),
            ssh("other.example", 22, "ci"),
        ] {
            let b = FilesystemId::ssh(&other);
            assert!(!same_filesystem(a.as_ref(), b.as_ref()), "{other:?}");
        }
    }

    #[test]
    fn the_same_host_behind_another_bastion_is_another_filesystem() {
        let direct = ssh("10.0.0.5", 22, "ci");
        let mut jumped = direct.clone();
        jumped.proxy_jump = vec![JumpHostConfig {
            host: "bastion.example".to_string(),
            username: "ci".to_string(),
            ..JumpHostConfig::default()
        }];
        assert!(!same_filesystem(
            FilesystemId::ssh(&direct).as_ref(),
            FilesystemId::ssh(&jumped).as_ref()
        ));
    }

    #[test]
    fn an_unknown_end_never_matches() {
        assert!(FilesystemId::ssh(&ssh("", 22, "ci")).is_none());
        let local = FilesystemId::Local;
        assert!(!same_filesystem(None, None));
        assert!(!same_filesystem(Some(&local), None));
    }

    #[test]
    fn an_agent_host_is_per_agent_and_not_the_desktop() {
        let a = FilesystemId::agent_host("agent-1");
        assert_eq!(a, FilesystemId::agent_host("agent-1"));
        assert_ne!(a, FilesystemId::agent_host("agent-2"));
        assert_ne!(a, FilesystemId::Local);
    }
}
