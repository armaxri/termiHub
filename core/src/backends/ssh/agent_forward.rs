//! SSH agent forwarding (OpenSSH `ForwardAgent`) for the russh connect path.
//!
//! When a connection opts in via [`SshConfig::forward_agent`](crate::config::SshConfig::forward_agent),
//! the session channel requests `auth-agent-req@openssh.com` (see
//! [`connector`](super::connector)). The server then opens an
//! `auth-agent@openssh.com` channel back whenever a program on the target
//! contacts its `$SSH_AUTH_SOCK`; russh dispatches that to
//! [`TermiHubHandler::server_channel_open_agent_forward`](super::handler), which
//! calls [`spawn_forwarded_agent_bridge`] here.
//!
//! Bridging is library-first and protocol-agnostic: rather than re-implementing
//! the SSH agent protocol, we open a raw stream to the **local** agent and pump
//! bytes both ways between it and the forwarded channel. The remote speaks the
//! agent protocol; our local `ssh-agent` answers it.
//!
//! Absence of a local agent (`SSH_AUTH_SOCK` unset, or the Windows OpenSSH agent
//! stopped) is a no-op with a debug log — it never fails the connection (#1699).

use russh::client::Msg;
use russh::Channel;
use tokio::io::{AsyncRead, AsyncWrite};
use tracing::debug;

/// A raw, bidirectional connection to the local SSH agent, type-erased so callers
/// in other crates can pump bytes without naming the platform stream type.
///
/// Implemented by whatever [`connect_local_agent`] yields on each platform
/// (Unix domain socket, Windows named pipe). The desktop reuses this to bridge
/// its own local agent to a session forwarded over the JSON-RPC agent transport
/// (#1727), so that path connects to the operator's agent through the exact same
/// logic the russh bridge uses here.
pub trait LocalAgentStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> LocalAgentStream for T {}

/// Open a boxed raw stream to the local SSH agent, or an error when none is
/// reachable (`SSH_AUTH_SOCK` unset / the Windows OpenSSH agent stopped).
///
/// The type-erased sibling of [`connect_local_agent`] for cross-crate callers
/// (the desktop's agent-forward relay endpoint, #1727). Absence of an agent is
/// the caller's cue for a graceful no-op, exactly as [`local_agent_available`]
/// gates the russh path.
pub async fn connect_local_agent_boxed() -> std::io::Result<Box<dyn LocalAgentStream>> {
    Ok(Box::new(connect_local_agent().await?))
}

/// Connect a raw byte stream to the local SSH agent (Unix `$SSH_AUTH_SOCK`).
#[cfg(unix)]
async fn connect_local_agent() -> std::io::Result<tokio::net::UnixStream> {
    let sock = std::env::var_os("SSH_AUTH_SOCK")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "SSH_AUTH_SOCK is not set (no running ssh-agent)",
            )
        })?;
    tokio::net::UnixStream::connect(sock).await
}

/// Connect a raw byte stream to the local SSH agent (Windows OpenSSH named pipe).
#[cfg(windows)]
async fn connect_local_agent() -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient>
{
    tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\openssh-ssh-agent")
}

/// Neither Unix domain sockets nor the Windows agent pipe exist on other targets;
/// agent forwarding is unavailable there.
#[cfg(not(any(unix, windows)))]
async fn connect_local_agent() -> std::io::Result<tokio::net::TcpStream> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "SSH agent forwarding is not supported on this platform",
    ))
}

/// Whether a local SSH agent is reachable right now.
///
/// Used by the connector as a pre-check so a `forward_agent` connection with no
/// running agent logs one clear line and skips the request, instead of asking a
/// server to forward an agent that cannot be bridged. It actually opens (and
/// immediately drops) a connection, so it reflects a *live* agent rather than
/// merely a set `SSH_AUTH_SOCK`.
pub(crate) async fn local_agent_available() -> bool {
    match connect_local_agent().await {
        Ok(_) => true,
        Err(e) => {
            debug!("no local SSH agent available for forwarding: {e}");
            false
        }
    }
}

/// Bridge a server-opened agent-forwarding channel to the local SSH agent.
///
/// Spawns a detached task that copies bytes in both directions between the
/// forwarded `channel` and a freshly-connected local agent stream, for the life
/// of the channel. If no local agent is reachable the channel is dropped (closed)
/// with a debug log — a forwarded request that arrives with no agent to answer it
/// is ignored, never fatal.
pub(crate) fn spawn_forwarded_agent_bridge(channel: Channel<Msg>) {
    tokio::spawn(async move {
        let mut agent = match connect_local_agent().await {
            Ok(agent) => agent,
            Err(e) => {
                debug!("dropping forwarded agent channel; no local agent to bridge: {e}");
                return;
            }
        };
        let mut stream = channel.into_stream();
        match tokio::io::copy_bidirectional(&mut stream, &mut agent).await {
            Ok((to_agent, to_server)) => {
                debug!(to_agent, to_server, "forwarded SSH agent channel closed")
            }
            Err(e) => debug!("forwarded SSH agent bridge ended: {e}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With `SSH_AUTH_SOCK` unset, no agent is reported available — the connector
    /// relies on this to skip the forwarding request and log a no-op (#1699).
    #[cfg(unix)]
    #[tokio::test]
    async fn local_agent_unavailable_when_sock_unset() {
        // SAFETY: single-threaded test mutating a process env var it restores.
        let orig = std::env::var_os("SSH_AUTH_SOCK");
        unsafe { std::env::remove_var("SSH_AUTH_SOCK") };
        let available = local_agent_available().await;
        if let Some(val) = orig {
            unsafe { std::env::set_var("SSH_AUTH_SOCK", val) };
        }
        assert!(
            !available,
            "no agent should be reachable without SSH_AUTH_SOCK"
        );
    }

    /// A pointer to a non-existent socket path is likewise unavailable rather than
    /// an error that could abort a connect.
    #[cfg(unix)]
    #[tokio::test]
    async fn local_agent_unavailable_for_dangling_sock_path() {
        // SAFETY: single-threaded test mutating a process env var it restores.
        let orig = std::env::var_os("SSH_AUTH_SOCK");
        unsafe { std::env::set_var("SSH_AUTH_SOCK", "/nonexistent/thub-agent-forward-test.sock") };
        let available = local_agent_available().await;
        match orig {
            Some(val) => unsafe { std::env::set_var("SSH_AUTH_SOCK", val) },
            None => unsafe { std::env::remove_var("SSH_AUTH_SOCK") },
        }
        assert!(
            !available,
            "a dangling SSH_AUTH_SOCK path is not a live agent"
        );
    }
}
