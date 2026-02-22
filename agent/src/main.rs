#[cfg(unix)]
mod daemon;
#[cfg(unix)]
mod docker;
mod files;
mod handler;
mod io;
mod monitoring;
mod protocol;
mod registry;
mod serial;
mod session;
#[cfg(unix)]
mod shell;
#[cfg(unix)]
mod ssh;
#[cfg(unix)]
mod state;
mod transport;

use tokio_util::sync::CancellationToken;
use tracing::info;
use tracing_subscriber::EnvFilter;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7685";

fn print_usage() {
    eprintln!("Usage: termihub-agent <MODE>");
    eprintln!();
    eprintln!("Modes:");
    eprintln!("  --stdio              Run in stdio mode (NDJSON over stdin/stdout)");
    eprintln!("  --listen [addr]      Run in TCP listener mode (default: {DEFAULT_LISTEN_ADDR})");
    eprintln!("  --daemon <id>        Run as a session daemon (internal use only)");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --version   Print version and exit");
    eprintln!("  --help      Print this help message");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    match args[1].as_str() {
        "--version" => {
            println!("termihub-agent {}", VERSION);
            Ok(())
        }
        "--help" => {
            print_usage();
            Ok(())
        }
        "--stdio" => {
            // Configure tracing to stderr so it doesn't interfere with the protocol on stdout
            init_tracing();

            let shutdown = setup_shutdown_signal();
            info!("termihub-agent {} starting in stdio mode", VERSION);
            io::stdio::run_stdio_loop(shutdown).await
        }
        "--listen" => {
            init_tracing();

            let addr = args
                .get(2)
                .map(|s| s.as_str())
                .unwrap_or(DEFAULT_LISTEN_ADDR);
            let shutdown = setup_shutdown_signal();
            info!(
                "termihub-agent {} starting in TCP listener mode on {}",
                VERSION, addr
            );
            io::tcp::run_tcp_listener(addr, shutdown).await
        }
        #[cfg(unix)]
        "--daemon" => {
            init_tracing();

            let session_id = args.get(2).unwrap_or_else(|| {
                eprintln!("--daemon requires a session ID argument");
                std::process::exit(1);
            });
            daemon::process::run_daemon(session_id).await
        }
        other => {
            eprintln!("Unknown option: {}", other);
            print_usage();
            std::process::exit(1);
        }
    }
}

/// Initialize the tracing subscriber with stderr output.
fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
}

/// Set up signal handlers for graceful shutdown.
///
/// Listens for SIGTERM and SIGINT (Ctrl+C) and triggers the
/// returned `CancellationToken` when either is received.
fn setup_shutdown_signal() -> CancellationToken {
    let token = CancellationToken::new();
    let token_clone = token.clone();

    tokio::spawn(async move {
        let ctrl_c = tokio::signal::ctrl_c();

        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm =
                signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");

            tokio::select! {
                _ = ctrl_c => {
                    info!("Received SIGINT (Ctrl+C), initiating shutdown");
                }
                _ = sigterm.recv() => {
                    info!("Received SIGTERM, initiating shutdown");
                }
            }
        }

        #[cfg(not(unix))]
        {
            let _ = ctrl_c.await;
            info!("Received Ctrl+C, initiating shutdown");
        }

        token_clone.cancel();
    });

    token
}
