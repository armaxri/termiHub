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
    connect_local_agent_at(std::env::var_os("SSH_AUTH_SOCK")).await
}

/// Connect to the local SSH agent at an explicit socket path (Unix).
///
/// The path-injecting core of [`connect_local_agent`], which passes the live
/// `$SSH_AUTH_SOCK`. An empty or absent path is treated as "no agent" and yields
/// a `NotFound` error, matching the graceful no-op the connector relies on
/// (#1699). Keeping the env read out of this function lets tests exercise the
/// unset / dangling-path cases by value, without mutating the process-global
/// `SSH_AUTH_SOCK` and racing other parallel tests (#2122).
#[cfg(unix)]
async fn connect_local_agent_at(
    sock: Option<std::ffi::OsString>,
) -> std::io::Result<tokio::net::UnixStream> {
    let sock = sock.filter(|s| !s.is_empty()).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "SSH_AUTH_SOCK is not set (no running ssh-agent)",
        )
    })?;
    tokio::net::UnixStream::connect(sock).await
}

/// Env var that overrides the Windows agent-bridge target named pipe (#2038).
///
/// The unix relay hands the session daemon a per-session `$SSH_AUTH_SOCK`; the
/// Windows bridge has no such convention baked in (it opens a *fixed* OpenSSH
/// pipe and ignores `SSH_AUTH_SOCK`), so the per-session relay pipe is injected
/// through this dedicated variable instead — keeping it clear of a real local
/// OpenSSH agent. Only the session daemon ever has it set, so the desktop's own
/// [`connect_local_agent_boxed`] still reaches the operator's real agent pipe.
#[cfg(windows)]
pub const AGENT_PIPE_ENV: &str = "TERMIHUB_SSH_AGENT_PIPE";

/// The fixed OpenSSH agent pipe used when no per-session override is injected.
#[cfg(windows)]
const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Connect a raw byte stream to the local SSH agent (Windows OpenSSH named pipe).
///
/// Honors [`AGENT_PIPE_ENV`] when set — the per-session relay pipe injected into
/// the session daemon (#2038) — and otherwise the fixed OpenSSH agent pipe. When
/// the target pipe reports every instance momentarily busy (`ERROR_PIPE_BUSY`,
/// which the relay causes for a tiny window while it re-arms its next server
/// instance), it retries briefly rather than failing; a genuinely absent pipe
/// returns `NotFound` immediately, preserving the graceful no-op.
#[cfg(windows)]
async fn connect_local_agent() -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient>
{
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

    let pipe = std::env::var_os(AGENT_PIPE_ENV)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| OPENSSH_AGENT_PIPE.into());

    // A handful of quick retries covers the re-arm race without hanging: at
    // 25 ms each this is well under a second, and only ERROR_PIPE_BUSY loops —
    // every other error (including a missing pipe) returns at once.
    const MAX_ATTEMPTS: u32 = 20;
    for attempt in 0..MAX_ATTEMPTS {
        match ClientOptions::new().open(&pipe) {
            Ok(client) => return Ok(client),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                if attempt + 1 == MAX_ATTEMPTS {
                    return Err(e);
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("loop returns on the final attempt")
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

    /// With no socket path (`SSH_AUTH_SOCK` unset), no agent is reachable — the
    /// connector relies on this to skip the forwarding request and log a no-op
    /// (#1699). Exercised through the injectable seam so the test never mutates
    /// the process-global `SSH_AUTH_SOCK` and cannot race sibling tests (#2122).
    #[cfg(unix)]
    #[tokio::test]
    async fn local_agent_unavailable_when_sock_unset() {
        assert!(
            connect_local_agent_at(None).await.is_err(),
            "no agent should be reachable without SSH_AUTH_SOCK"
        );
    }

    /// An empty socket path is treated the same as unset — a stray empty
    /// `SSH_AUTH_SOCK` must not be taken for a live agent.
    #[cfg(unix)]
    #[tokio::test]
    async fn local_agent_unavailable_when_sock_empty() {
        assert!(
            connect_local_agent_at(Some(std::ffi::OsString::new()))
                .await
                .is_err(),
            "an empty SSH_AUTH_SOCK is not a live agent"
        );
    }

    /// A pointer to a non-existent socket path is likewise unavailable rather than
    /// an error that could abort a connect. Passed by value through the seam, so
    /// no process env is touched (#2122).
    #[cfg(unix)]
    #[tokio::test]
    async fn local_agent_unavailable_for_dangling_sock_path() {
        assert!(
            connect_local_agent_at(Some("/nonexistent/thub-agent-forward-test.sock".into()))
                .await
                .is_err(),
            "a dangling SSH_AUTH_SOCK path is not a live agent"
        );
    }
}
