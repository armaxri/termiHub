//! `termihub-rdp-helper` — the RDP sidecar binary (#1747).
//!
//! IronRDP's CredSSP crypto (`picky`/`sspi`) and `russh` pin mutually
//! incompatible RustCrypto pre-releases, and Cargo allows one version per crate
//! per lockfile (#1725). This crate is therefore **excluded from the workspace**
//! (`[workspace].exclude`) and carries its **own `Cargo.lock`**, so IronRDP
//! resolves in a graph with no russh. The desktop (`termihub-core`'s `SidecarRdp`
//! adapter) spawns this binary per RDP session and speaks the framed
//! [`termihub_core::backends::rdp_sidecar::protocol`] IPC over stdio.
//!
//! Lifecycle: read one [`HostMessage::Connect`] (credentials included) from
//! stdin, connect + authenticate, then stream decoded frames / cursor updates
//! out on stdout while applying host input read from stdin. All logging goes to
//! stderr so it never corrupts the binary IPC stream on stdout.

mod clipboard;
mod input;
mod keymap;
mod rdp;

use anyhow::{bail, Context, Result};
use termihub_core::backends::rdp_sidecar::protocol::SidecarMessage;
use termihub_core::backends::rdp_sidecar::protocol::{read_message, write_message, HostMessage};
use termihub_core::connection::GraphicalState;

#[tokio::main]
async fn main() -> Result<()> {
    // Logs go to stderr; stdout is the binary IPC channel and must stay clean.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    write_message(
        &mut stdout,
        &SidecarMessage::State(GraphicalState::Connecting),
    )
    .await
    .context("failed to write initial state")?;

    // The first message must be Connect; its RdpConfig carries the credentials,
    // which is why they arrive over stdin rather than argv/env.
    let cfg = match read_message::<_, HostMessage>(&mut stdin).await {
        Ok(HostMessage::Connect(cfg)) => *cfg,
        Ok(other) => bail!("expected Connect as the first message, got {other:?}"),
        Err(e) => bail!("failed to read Connect message: {e}"),
    };

    if let Err(e) = rdp::run_session(cfg, &mut stdin, &mut stdout).await {
        // Surface the failure to the host, then exit non-zero.
        let _ = write_message(&mut stdout, &SidecarMessage::Error(format!("{e:#}"))).await;
        return Err(e);
    }

    Ok(())
}
