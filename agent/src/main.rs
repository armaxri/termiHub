mod client_registry;
mod daemon;
mod files;
mod fs;
mod handler;
mod io;
mod monitoring;
mod network;
mod protocol;
mod registry;
mod registry_daemon;
mod service;
mod session;
mod state;
mod transport;
mod tunnel;
mod update;

use tokio_util::sync::CancellationToken;
use tracing::info;
use tracing_subscriber::EnvFilter;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const BRANCH: &str = env!("TERMIHUB_BUILD_BRANCH");
const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7685";

fn print_usage() {
    eprintln!("Usage: termihub-agent <MODE>");
    eprintln!();
    eprintln!("Modes:");
    eprintln!("  --stdio              Run in stdio mode (NDJSON over stdin/stdout)");
    eprintln!("  --listen [addr]      Run in TCP listener mode (default: {DEFAULT_LISTEN_ADDR})");
    eprintln!("  --daemon <id>        Run as a session daemon (internal use only)");
    eprintln!("  --registry-daemon    Run as the host-wide client registry (internal use only)");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --version             Print version and exit");
    eprintln!("  --help                Print this help message");
    eprintln!(
        "  --allow-self-update   Enable the background GitHub self-update check (off by default)"
    );
    eprintln!("  --update-strategy <s> Self-update apply strategy: immediate|coordinated|deferred");
}

/// CLI flag / env var that opts the agent into the background self-update check.
const SELF_UPDATE_FLAG: &str = "--allow-self-update";
const SELF_UPDATE_ENV: &str = "TERMIHUB_AGENT_ALLOW_SELF_UPDATE";
/// CLI flag carrying the connection's configured self-update apply strategy.
const UPDATE_STRATEGY_FLAG: &str = "--update-strategy";

/// Env var that caps the agent's Tokio worker-thread count (#2495).
///
/// Unset — the production default — the agent runs the same multi-thread runtime
/// `#[tokio::main]` builds: `worker_threads` = available parallelism. Set to a
/// positive integer, the worker-thread count is capped to that value instead.
/// Only the integration-test harness opts in: it spawns many agent processes
/// concurrently, and without a cap each would start `num_cpus` worker threads,
/// oversubscribing a loaded CI runner and making the agent slow-to-respond (the
/// Windows 10060 flake). An absent or unparseable value is byte-identical to the
/// default runtime.
const WORKER_THREADS_ENV: &str = "TERMIHUB_AGENT_WORKER_THREADS";

/// Determine whether the agent should run the optional self-update check.
///
/// Enabled when the `--allow-self-update` flag is passed (the desktop appends it
/// to the SSH exec command when the connection has self-update enabled) or when
/// `TERMIHUB_AGENT_ALLOW_SELF_UPDATE` is set to a truthy value. Off by default.
fn self_update_enabled(args: &[String]) -> bool {
    if args.iter().any(|a| a == SELF_UPDATE_FLAG) {
        return true;
    }
    matches!(
        std::env::var(SELF_UPDATE_ENV).ok().as_deref(),
        Some("1") | Some("true") | Some("yes")
    )
}

/// Parse the `--update-strategy <value>` CLI flag (#1401).
///
/// The desktop appends it alongside `--allow-self-update` so the agent knows
/// whether a self-downloaded update may auto-apply on idle. Absent or unknown
/// values default to [`UpdateStrategy::Immediate`].
fn update_strategy_from_args(args: &[String]) -> update::UpdateStrategy {
    args.iter()
        .position(|a| a == UPDATE_STRATEGY_FLAG)
        .and_then(|i| args.get(i + 1))
        .map(|v| update::UpdateStrategy::from_cli(v))
        .unwrap_or_default()
}

fn main() -> anyhow::Result<()> {
    build_runtime().block_on(run())
}

/// Build the agent's Tokio runtime.
///
/// Mirrors what `#[tokio::main]` builds — a multi-thread runtime with all drivers
/// enabled and `worker_threads` defaulting to available parallelism — so with
/// [`WORKER_THREADS_ENV`] absent the behavior is byte-identical to the previous
/// `#[tokio::main]` entry point. When the env var is set to a positive integer,
/// the worker-thread count is capped to it (test-harness contention control only;
/// see [`WORKER_THREADS_ENV`]).
fn build_runtime() -> tokio::runtime::Runtime {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    if let Some(n) = worker_threads_override(std::env::var(WORKER_THREADS_ENV).ok()) {
        builder.worker_threads(n);
    }
    builder
        .build()
        .expect("failed to build the agent Tokio runtime")
}

/// Parse the [`WORKER_THREADS_ENV`] value into a worker-thread cap.
///
/// A positive integer caps the runtime to that many worker threads; anything
/// else — absent, empty, non-numeric, or zero — yields `None`, meaning "use the
/// runtime default" (byte-identical to `#[tokio::main]`).
fn worker_threads_override(raw: Option<String>) -> Option<usize> {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
}

async fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    match args[1].as_str() {
        "--version" => {
            if BRANCH == "unknown" || BRANCH.is_empty() {
                println!("termihub-agent {VERSION}");
            } else {
                println!("termihub-agent {VERSION} (branch: {BRANCH})");
            }
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
            let allow_self_update = self_update_enabled(&args);
            let update_strategy = update_strategy_from_args(&args);
            info!("termihub-agent {} starting in stdio mode", VERSION);
            io::stdio::run_stdio_loop(shutdown, allow_self_update, update_strategy).await
        }
        "--listen" => {
            init_tracing();

            // The listen address is optional; skip it (and any other flags) when
            // resolving the address so `--allow-self-update` is not mistaken for it.
            let addr = args
                .get(2)
                .filter(|s| !s.starts_with("--"))
                .map(|s| s.as_str())
                .unwrap_or(DEFAULT_LISTEN_ADDR);
            let shutdown = setup_shutdown_signal();
            let allow_self_update = self_update_enabled(&args);
            let update_strategy = update_strategy_from_args(&args);
            info!(
                "termihub-agent {} starting in TCP listener mode on {}",
                VERSION, addr
            );
            io::tcp::run_tcp_listener(addr, shutdown, allow_self_update, update_strategy).await
        }
        "--daemon" => {
            init_tracing();

            let session_id = args.get(2).unwrap_or_else(|| {
                eprintln!("--daemon requires a session ID argument");
                std::process::exit(1);
            });
            daemon::process::run_daemon(session_id).await
        }
        "--registry-daemon" => {
            init_tracing();

            // Spawned by a worker that could not find a registry (see
            // `registry_daemon::client`), never by a user. Exits on its own once
            // it has been idle, and exits immediately — successfully — if
            // another registry already owns the endpoint.
            info!(
                "termihub-agent {} starting as the host-wide registry",
                VERSION
            );
            registry_daemon::process::run_registry_daemon().await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn self_update_flag_present_enables() {
        assert!(self_update_enabled(&args(&[
            "termihub-agent",
            "--stdio",
            SELF_UPDATE_FLAG
        ])));
        assert!(self_update_enabled(&args(&[
            "termihub-agent",
            "--listen",
            "127.0.0.1:7685",
            SELF_UPDATE_FLAG
        ])));
    }

    #[test]
    fn self_update_absent_is_disabled_by_default() {
        // No flag, and the env var is not set in this test process.
        assert!(!self_update_enabled(&args(&["termihub-agent", "--stdio"])));
    }

    #[test]
    fn update_strategy_parses_from_flag() {
        use update::UpdateStrategy;
        assert_eq!(
            update_strategy_from_args(&args(&[
                "termihub-agent",
                "--stdio",
                "--allow-self-update",
                "--update-strategy",
                "deferred",
            ])),
            UpdateStrategy::Deferred
        );
        assert_eq!(
            update_strategy_from_args(&args(&[
                "termihub-agent",
                "--stdio",
                "--update-strategy",
                "coordinated",
            ])),
            UpdateStrategy::Coordinated
        );
    }

    #[test]
    fn worker_threads_override_parses_positive_and_rejects_the_rest() {
        // A positive integer caps the runtime.
        assert_eq!(worker_threads_override(Some("2".to_string())), Some(2));
        assert_eq!(
            worker_threads_override(Some("  4 ".to_string())),
            Some(4),
            "surrounding whitespace is tolerated"
        );
        // Absent / empty / non-numeric / zero all mean "use the default".
        assert_eq!(worker_threads_override(None), None);
        assert_eq!(worker_threads_override(Some("".to_string())), None);
        assert_eq!(worker_threads_override(Some("nope".to_string())), None);
        assert_eq!(
            worker_threads_override(Some("0".to_string())),
            None,
            "zero worker threads is invalid; fall back to the default"
        );
    }

    #[test]
    fn update_strategy_defaults_to_immediate_when_absent_or_unknown() {
        use update::UpdateStrategy;
        assert_eq!(
            update_strategy_from_args(&args(&["termihub-agent", "--stdio"])),
            UpdateStrategy::Immediate
        );
        assert_eq!(
            update_strategy_from_args(&args(&[
                "termihub-agent",
                "--stdio",
                "--update-strategy",
                "bogus",
            ])),
            UpdateStrategy::Immediate
        );
    }
}
