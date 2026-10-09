// TOOL-010: enforce the "no `.unwrap()`/`.expect()`/`panic!` in production Rust"
// policy (see `.claude/CLAUDE.md` → Rust). Denied for non-test builds; test code
// (`#[cfg(test)]` modules and `tests/` crates) is exempt via `not(test)`.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

mod client_registry;
mod daemon;
mod file_log;
mod files;
mod fs;
mod handler;
mod io;
mod ki_prompt;
mod monitoring;
mod network;
mod panic_hook;
mod protocol;
mod registry;
mod registry_daemon;
mod service;
mod session;
mod state;
mod store_version;
mod test_parent_watchdog;
mod transport;
mod tunnel;
mod update;

// `RUSSH_CLAMP` is the floor applied to `russh` on the framed stderr sink,
// whatever `RUST_LOG` says. The desktop re-emits framed records into its durable
// `termihub.log`, so the same clamp the file sinks apply holds here: russh's
// per-packet DEBUG/TRACE output never reaches a durable log unless a directive
// names `russh` explicitly. Shared with the desktop (#4319).
use termihub_core::diagnostics::file_log::RUSSH_CLAMP;
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
    // Test-harness only: exit when the spawning test process dies (#3641).
    // Inert unless `TERMIHUB_TEST_PARENT_PID` is set.
    test_parent_watchdog::start_from_env();
    build_runtime()?.block_on(run())
}

/// Build the agent's Tokio runtime.
///
/// Mirrors what `#[tokio::main]` builds — a multi-thread runtime with all drivers
/// enabled and `worker_threads` defaulting to available parallelism — so with
/// [`WORKER_THREADS_ENV`] absent the behavior is byte-identical to the previous
/// `#[tokio::main]` entry point. When the env var is set to a positive integer,
/// the worker-thread count is capped to it (test-harness contention control only;
/// see [`WORKER_THREADS_ENV`]).
fn build_runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    if let Some(n) = worker_threads_override(std::env::var(WORKER_THREADS_ENV).ok()) {
        builder.worker_threads(n);
    }
    builder
        .build()
        .map_err(|e| anyhow::anyhow!("failed to build the agent Tokio runtime: {e}"))
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
            // Tracing goes to stderr so it never interferes with the protocol on
            // stdout — as framed records the desktop re-emits at their real
            // level and target (#2854, OBS-004).
            init_tracing(StderrLogFormat::Framed, file_log::AgentRole::Stdio);

            let shutdown = setup_shutdown_signal();
            let allow_self_update = self_update_enabled(&args);
            let update_strategy = update_strategy_from_args(&args);
            info!("termihub-agent {} starting in stdio mode", VERSION);
            io::stdio::run_stdio_loop(shutdown, allow_self_update, update_strategy).await
        }
        "--listen" => {
            init_tracing(StderrLogFormat::Plain, file_log::AgentRole::Listen);

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
            init_tracing(StderrLogFormat::Plain, file_log::AgentRole::Daemon);

            let session_id = args.get(2).unwrap_or_else(|| {
                eprintln!("--daemon requires a session ID argument");
                std::process::exit(1);
            });
            daemon::process::run_daemon(session_id).await
        }
        "--registry-daemon" => {
            init_tracing(StderrLogFormat::Plain, file_log::AgentRole::Registry);

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

/// How the stderr sink renders records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StderrLogFormat {
    /// Human-readable `fmt` lines — for the `--listen` / `--daemon` /
    /// `--registry-daemon` roles, whose stderr nobody parses.
    Plain,
    /// One structured [`termihub_agent::log_frame`] record per line — for the
    /// `--stdio` role, whose stderr the desktop captures and re-emits at each
    /// record's real level and target (#2854, OBS-004).
    Framed,
}

/// The env-filter directive for the stderr sink, given `RUST_LOG`.
///
/// `RUST_LOG` (default `info`) as before; the [`StderrLogFormat::Framed`] sink
/// additionally gets [`RUSSH_CLAMP`] prepended.
fn stderr_filter_directive(format: StderrLogFormat, rust_log: Option<&str>) -> String {
    let base = rust_log
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .unwrap_or("info");
    match format {
        StderrLogFormat::Plain => base.to_string(),
        StderrLogFormat::Framed => format!("{RUSSH_CLAMP},{base}"),
    }
}

/// Build the env-filter for the stderr sink (see [`stderr_filter_directive`]).
/// An unparsable `RUST_LOG` falls back to the default rather than failing.
fn stderr_env_filter(format: StderrLogFormat) -> EnvFilter {
    let rust_log = std::env::var(EnvFilter::DEFAULT_ENV).ok();
    EnvFilter::try_new(stderr_filter_directive(format, rust_log.as_deref()))
        .unwrap_or_else(|_| EnvFilter::new(stderr_filter_directive(format, None)))
}

/// Whether `role` mirrors tracing to stderr, given whether its log file opened.
///
/// A detached daemon's stderr is only a capped capture file; mirroring every
/// record there would duplicate the log file line for line (audit OBS2-007), so
/// it is used only as the fallback when the log file could not be opened.
fn mirror_to_stderr(role: file_log::AgentRole, file_opened: bool) -> bool {
    !(role.is_detached() && file_opened)
}

/// Initialize the tracing subscriber for `role`.
///
/// Installs up to two layers on one registry (audit OBS-003):
///
/// - a **durable rotating file** layer ([`file_log`]) written for *every* role,
///   into this process's own `termihub-agent-<role>-<pid>.log` (#4319), so the
///   `--daemon` / `--listen` / `--registry-daemon` roles — whose stderr goes to
///   the remote host with no capture path — leave a retrievable, size-bounded
///   trace next to the agent's `state.json`;
/// - a **stderr** layer (`RUST_LOG`, default `info`). For the interactive
///   `--stdio` role it writes framed records ([`StderrLogFormat::Framed`]) the
///   desktop parses; for `--listen` plain `fmt` lines. The detached daemon
///   roles' stderr is only a capture file, so they get this layer only when
///   the log file could not be opened — otherwise it would just duplicate the
///   file line for line (audit OBS2-007).
///
/// Opening the log file is best-effort: if it cannot be opened (read-only home,
/// no config dir), the agent logs a warning to stderr and runs with the stderr
/// layer alone rather than failing to start.
fn init_tracing(format: StderrLogFormat, role: file_log::AgentRole) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::Layer;

    let file = file_log::open(role);
    let want_stderr = mirror_to_stderr(role, file.is_ok());

    let plain_layer = (want_stderr && format == StderrLogFormat::Plain).then(|| {
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_filter(stderr_env_filter(format))
    });
    let framed_layer = (want_stderr && format == StderrLogFormat::Framed).then(|| {
        termihub_agent::log_frame::FramedStderrLayer::new(std::io::stderr)
            .with_filter(stderr_env_filter(format))
    });
    let registry = tracing_subscriber::registry()
        .with(plain_layer)
        .with(framed_layer);

    match file {
        Ok(file) => {
            let path = file.path();
            let file_layer = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file)
                .with_filter(file_log::file_env_filter());
            registry.with(file_layer).init();
            info!("agent log file at {}", path.display());
        }
        Err(e) => {
            registry.init();
            tracing::warn!(
                "could not open the agent log file at {}: {e}; logging to stderr only",
                file_log::log_file_path(role).display()
            );
        }
    }

    // A detached daemon's stderr is a capture file; keep it bounded (OBS2-007).
    if role.is_detached() {
        file_log::spawn_stderr_cap_watchdog();
    }

    // Local, redacted crash reports next to the log (OBS-010).
    panic_hook::install(panic_hook::crash_dir());
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
            match signal(SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    tokio::select! {
                        _ = ctrl_c => {
                            info!("Received SIGINT (Ctrl+C), initiating shutdown");
                        }
                        _ = sigterm.recv() => {
                            info!("Received SIGTERM, initiating shutdown");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "Failed to register SIGTERM handler; listening for SIGINT only"
                    );
                    let _ = ctrl_c.await;
                    info!("Received SIGINT (Ctrl+C), initiating shutdown");
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

    #[test]
    fn detached_daemons_mirror_to_stderr_only_without_a_log_file() {
        use file_log::AgentRole;
        // OBS2-007: with the log file open, a daemon's stderr capture must not
        // duplicate it.
        assert!(!mirror_to_stderr(AgentRole::Daemon, true));
        assert!(!mirror_to_stderr(AgentRole::Registry, true));
        // Without a log file, stderr is the only record left.
        assert!(mirror_to_stderr(AgentRole::Daemon, false));
        assert!(mirror_to_stderr(AgentRole::Registry, false));
        // Interactive roles keep their stderr: the desktop parses `--stdio`'s,
        // and `--listen`'s is the operator's console or journal.
        assert!(mirror_to_stderr(AgentRole::Stdio, true));
        assert!(mirror_to_stderr(AgentRole::Listen, true));
    }

    #[test]
    fn framed_stderr_filter_clamps_russh_and_plain_keeps_rust_log() {
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Framed, None),
            "russh=warn,info"
        );
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Framed, Some("debug")),
            "russh=warn,debug"
        );
        // An explicit russh directive still wins (it comes later).
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Framed, Some("debug,russh=trace")),
            "russh=warn,debug,russh=trace"
        );
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Plain, None),
            "info"
        );
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Plain, Some("  ")),
            "info"
        );
        assert_eq!(
            stderr_filter_directive(StderrLogFormat::Plain, Some("debug")),
            "debug"
        );
    }

    #[test]
    fn framed_stderr_filter_drops_russh_debug() {
        use tracing::subscriber::NoSubscriber;
        use tracing::Dispatch;
        use tracing_subscriber::layer::SubscriberExt;
        // Pin two no-op dispatchers so a parallel test cannot cache these
        // callsites' interest as `never` for the scoped subscriber below.
        static PINNED: std::sync::OnceLock<[Dispatch; 2]> = std::sync::OnceLock::new();
        PINNED.get_or_init(|| {
            [
                Dispatch::new(NoSubscriber::default()),
                Dispatch::new(NoSubscriber::default()),
            ]
        });
        // A framed sink under RUST_LOG=debug still never passes russh DEBUG.
        let filter = EnvFilter::new(stderr_filter_directive(
            StderrLogFormat::Framed,
            Some("debug"),
        ));
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
        #[derive(Clone)]
        struct W(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for W {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let w = W(buf.clone());
        let layer = termihub_agent::log_frame::FramedStderrLayer::new(move || w.clone());
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::Layer::with_filter(layer, filter));
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "russh::cipher", "reading, seqn = 603");
            tracing::debug!(target: "termihub_agent::io", "kept");
        });
        let out = String::from_utf8(buf.lock().unwrap().clone()).unwrap();
        assert!(!out.contains("seqn"), "{out}");
        assert!(out.contains("kept"), "{out}");
    }
}
