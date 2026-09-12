//! Durable, bounded, rotating on-disk log for the remote agent (audit OBS-003).
//!
//! The agent historically logged only to **stderr** ([`crate::init_tracing`]).
//! Where that stderr goes depends on the run mode:
//!
//! - `--stdio` (interactive over SSH exec): the desktop captures the agent's
//!   stderr and re-logs it into `termihub.log`, so it is lossy but present.
//! - `--daemon` / `--listen` / `--registry-daemon` (the persistent daemon,
//!   registry-daemon, and TCP-listener roles): stderr goes to the *remote* host
//!   with **no capture path back to the desktop and no file sink** — the logs
//!   are simply lost. Those are exactly the roles behind session persistence,
//!   reconnect, the cross-desktop registry, and remote tunnels/services, so when
//!   something fails there the durable record that would explain it is gone.
//!
//! This module adds the missing durable sink for **all** roles: a rotating,
//! hard-capped log file in the agent's own config directory (next to
//! `state.json`), mirroring the desktop's [`file_log`] design so the two behave
//! identically.
//!
//! [`file_log`]: ../../../src-tauri/src/utils/file_log.rs
//!
//! # Design notes
//!
//! This mirrors `src-tauri/src/utils/file_log.rs` deliberately, reusing the same
//! proven approach rather than inventing a second one:
//!
//! **Why synchronous writes, not `tracing_appender::non_blocking`?** The
//! non-blocking writer hands events to a background thread over a channel; when
//! the process dies abruptly — SIGKILL, OOM, panic — whatever is still in that
//! channel is lost, and the lost tail is exactly what a post-mortem needs. At
//! INFO volume the cost of writing straight through is irrelevant.
//!
//! **Why a custom size-based rotator, not `tracing-appender`'s?**
//! `tracing-appender`'s rotation is *time*-based (`max_log_files` bounds the file
//! *count*, not their size), so a single runaway day — a reconnect loop on a
//! long-lived daemon, say — could still write an unbounded file on the remote
//! host. Size-based rotation gives a hard ceiling that does not depend on how the
//! agent behaves: at most [`MAX_FILE_BYTES`] × [`MAX_FILES`] on disk, always.
//! This is the same reasoning (and the same code shape) the desktop settled on.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// Base name of the current log file (`termihub-agent.log`).
const LOG_STEM: &str = "termihub-agent";

/// Extension of the log files.
const LOG_EXT: &str = "log";

/// Size at which the current log file is rotated away.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Total number of log files kept: the current one plus `MAX_FILES - 1`
/// archives. Together with [`MAX_FILE_BYTES`] this bounds on-disk usage at
/// 15 MiB on the remote host.
const MAX_FILES: usize = 3;

/// Filter directive for the *file* sink.
///
/// Keeps INFO and above so a durable log a support case is expected to read does
/// not drown in per-event debug spam. `TERMIHUB_AGENT_FILE_LOG` overrides this
/// when a case needs more detail — mirroring the desktop's `TERMIHUB_FILE_LOG`.
///
/// `russh` is clamped to WARN for the same reason the desktop clamps it: it
/// emits per-packet cipher logs below WARN, and this file is written to disk on
/// the remote host, so packet-level SSH internals must not reach it. See
/// [`RUSSH_CLAMP`], which keeps that true even when the override lowers the level.
const FILE_LOG_DIRECTIVE: &str = "info,russh=warn";

/// Floor applied to `russh` on top of *any* file directive, including a
/// `TERMIHUB_AGENT_FILE_LOG` override.
///
/// Without this, `TERMIHUB_AGENT_FILE_LOG=debug` would silently unclamp russh's
/// per-packet cipher logging into a durable file. A case that genuinely needs
/// russh internals can still ask for them explicitly
/// (`TERMIHUB_AGENT_FILE_LOG="debug,russh=debug"`) — later directives win — the
/// point is that it cannot happen by accident while only raising the agent's own
/// detail.
const RUSSH_CLAMP: &str = "russh=warn";

/// Environment variable overriding the file sink's filter directive.
const FILE_LOG_ENV: &str = "TERMIHUB_AGENT_FILE_LOG";

/// Build the [`EnvFilter`] for the file sink.
///
/// Honors [`FILE_LOG_ENV`] when set, else [`FILE_LOG_DIRECTIVE`]. An override
/// gets [`RUSSH_CLAMP`] prepended, so a directive that names `russh` explicitly
/// still wins (later directives take precedence in an `EnvFilter`) while one that
/// does not stays clamped.
pub fn file_env_filter() -> EnvFilter {
    match std::env::var(FILE_LOG_ENV) {
        Ok(directive) if !directive.trim().is_empty() => {
            EnvFilter::try_new(format!("{RUSSH_CLAMP},{directive}"))
                .unwrap_or_else(|_| EnvFilter::new(FILE_LOG_DIRECTIVE))
        }
        _ => EnvFilter::new(FILE_LOG_DIRECTIVE),
    }
}

/// Resolve the directory the agent log is written to.
///
/// A `logs/` subdirectory of the agent's config directory, so the rotated
/// archives sit next to `state.json` without cluttering it. Because it is
/// derived from [`crate::state::persistence::AgentState::config_dir`], it honors
/// `XDG_CONFIG_HOME` exactly as `state.json` does — so an integration test (or a
/// portable setup) that redirects the agent's state to a sandbox redirects its
/// log there too, rather than writing into the real user config dir.
pub fn log_dir() -> PathBuf {
    log_dir_in(crate::state::persistence::AgentState::config_dir())
}

/// The log directory given an agent config directory. Split out so the mapping
/// (`<config>/logs`) is testable without touching the process environment.
fn log_dir_in(config_dir: PathBuf) -> PathBuf {
    config_dir.join("logs")
}

/// Full path of the current (un-rotated) log file, for reporting.
pub fn log_file_path() -> PathBuf {
    log_dir().join(format!("{LOG_STEM}.{LOG_EXT}"))
}

/// A size-rotating, count-capped log file.
///
/// Cloneable and cheap to clone: clones share one file handle and one lock, so
/// interleaved writes from many threads stay whole.
#[derive(Clone)]
pub struct RotatingLogFile {
    inner: Arc<Mutex<Rotator>>,
}

impl RotatingLogFile {
    /// Open (or create) the log file in `dir`, rotating at `max_bytes` and
    /// keeping at most `max_files` files in total.
    ///
    /// Appends to an existing file so a restart does not discard the previous
    /// run — the run boundary is marked by the startup banner each role logs.
    pub fn new(dir: impl AsRef<Path>, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        let rotator = Rotator::open(dir.as_ref().to_path_buf(), max_bytes, max_files.max(1))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(rotator)),
        })
    }

    /// Open the log file at the agent's conventional location ([`log_dir`]) with
    /// the default size and count caps ([`MAX_FILE_BYTES`] × [`MAX_FILES`]).
    pub fn with_defaults() -> io::Result<Self> {
        Self::new(log_dir(), MAX_FILE_BYTES, MAX_FILES)
    }
}

impl<'a> MakeWriter<'a> for RotatingLogFile {
    type Writer = LockedRotator<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        // A poisoned lock means some other thread panicked mid-write. Losing the
        // log at exactly that moment is the opposite of what this module is for,
        // so recover the guard and keep writing.
        LockedRotator(self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Write guard handed to the `fmt` layer for the duration of one event.
pub struct LockedRotator<'a>(MutexGuard<'a, Rotator>);

impl Write for LockedRotator<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

/// The rotation state machine. Not public: all access goes through the lock.
struct Rotator {
    dir: PathBuf,
    file: File,
    /// Bytes in the *current* file, tracked rather than `stat`-ed per write.
    written: u64,
    max_bytes: u64,
    max_files: usize,
}

impl Rotator {
    fn open(dir: PathBuf, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let path = Self::path_in(&dir, 0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir,
            file,
            written,
            max_bytes,
            max_files,
        })
    }

    /// Path of log generation `generation`: 0 is the live file, 1..n the archives.
    fn path_in(dir: &Path, generation: usize) -> PathBuf {
        if generation == 0 {
            dir.join(format!("{LOG_STEM}.{LOG_EXT}"))
        } else {
            dir.join(format!("{LOG_STEM}.{generation}.{LOG_EXT}"))
        }
    }

    fn path(&self, generation: usize) -> PathBuf {
        Self::path_in(&self.dir, generation)
    }

    /// Shift every generation one older, dropping the oldest, and start a fresh
    /// live file.
    fn rotate(&mut self) -> io::Result<()> {
        let archives = self.max_files - 1;
        if archives == 0 {
            // Degenerate cap of one file: truncate in place.
            self.file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(self.path(0))?;
            self.written = 0;
            return Ok(());
        }

        // Drop the oldest, then walk backwards so nothing overwrites a file we
        // still need.
        let _ = fs::remove_file(self.path(archives));
        for generation in (1..archives).rev() {
            let _ = fs::rename(self.path(generation), self.path(generation + 1));
        }
        let _ = fs::rename(self.path(0), self.path(1));

        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.path(0))?;
        self.written = 0;
        Ok(())
    }
}

impl Write for Rotator {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Rotate *before* writing so a single event is never split across two
        // files. `written > 0` keeps an event larger than the cap from spinning
        // the rotation on an already-empty file.
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap_or_default()
    }

    #[test]
    fn writes_land_in_the_live_file() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 1024, 3).unwrap();

        log.make_writer().write_all(b"hello\n").unwrap();

        assert_eq!(read(&dir.path().join("termihub-agent.log")), "hello\n");
    }

    #[test]
    fn creates_the_log_directory_if_absent() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("deep").join("nested");

        RotatingLogFile::new(&nested, 1024, 3).unwrap();

        assert!(nested.join("termihub-agent.log").exists());
    }

    #[test]
    fn reopening_appends_rather_than_truncating() {
        let dir = tempfile::tempdir().unwrap();

        let first = RotatingLogFile::new(dir.path(), 1024, 3).unwrap();
        first.make_writer().write_all(b"run one\n").unwrap();
        drop(first);

        let second = RotatingLogFile::new(dir.path(), 1024, 3).unwrap();
        second.make_writer().write_all(b"run two\n").unwrap();

        assert_eq!(
            read(&dir.path().join("termihub-agent.log")),
            "run one\nrun two\n"
        );
    }

    #[test]
    fn rotates_once_the_size_cap_is_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 10, 3).unwrap();

        log.make_writer().write_all(b"aaaaa\n").unwrap(); // 6 bytes, fits
        log.make_writer().write_all(b"bbbbb\n").unwrap(); // would be 12 > 10

        assert_eq!(
            read(&dir.path().join("termihub-agent.log")),
            "bbbbb\n",
            "the live file should hold only the post-rotation write"
        );
        assert_eq!(
            read(&dir.path().join("termihub-agent.1.log")),
            "aaaaa\n",
            "the pre-rotation content should have moved to generation 1"
        );
    }

    #[test]
    fn rotation_never_splits_a_single_event() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 10, 3).unwrap();

        log.make_writer().write_all(b"aaaaa\n").unwrap();
        // An event larger than the whole cap must still be written whole.
        log.make_writer().write_all(b"a-very-long-event\n").unwrap();

        assert_eq!(
            read(&dir.path().join("termihub-agent.log")),
            "a-very-long-event\n",
            "an oversized event must land intact in the fresh file"
        );
    }

    #[test]
    fn generations_shift_and_the_oldest_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 10, 3).unwrap();

        for line in ["one\n", "two\n", "three\n", "four\n"] {
            // Each write is 4-6 bytes; pad past the cap to force a rotation per line.
            log.make_writer().write_all(line.as_bytes()).unwrap();
            log.make_writer().write_all(b"pad-to-force\n").unwrap();
        }

        // Only MAX_FILES generations may ever exist.
        assert!(dir.path().join("termihub-agent.log").exists());
        assert!(dir.path().join("termihub-agent.1.log").exists());
        assert!(dir.path().join("termihub-agent.2.log").exists());
        assert!(
            !dir.path().join("termihub-agent.3.log").exists(),
            "generation 3 exceeds the cap and must never be created"
        );
    }

    #[test]
    fn total_disk_usage_stays_bounded_under_sustained_writes() {
        let dir = tempfile::tempdir().unwrap();
        let max_bytes = 256;
        let max_files = 3;
        let log = RotatingLogFile::new(dir.path(), max_bytes, max_files).unwrap();

        // Write far more than the cap: 2000 * ~32B ≈ 64 KB against a 768 B cap.
        for i in 0..2000 {
            log.make_writer()
                .write_all(format!("event number {i} padding\n").as_bytes())
                .unwrap();
        }

        let total: u64 = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();

        // Each file may overshoot by at most one event, hence the slack.
        let ceiling = max_bytes * max_files as u64 + 1024;
        assert!(
            total <= ceiling,
            "log grew to {total} B, above the {ceiling} B ceiling — the cap is not holding"
        );
    }

    #[test]
    fn a_cap_of_one_file_truncates_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 10, 1).unwrap();

        log.make_writer().write_all(b"aaaaa\n").unwrap();
        log.make_writer().write_all(b"bbbbb\n").unwrap();

        assert_eq!(read(&dir.path().join("termihub-agent.log")), "bbbbb\n");
        assert!(!dir.path().join("termihub-agent.1.log").exists());
    }

    /// Render what `directive` admits for `russh` at DEBUG, without touching the
    /// process environment (which is global and would race other tests).
    fn russh_debug_reaches_file(directive: &str) -> bool {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 1 << 20, 3).unwrap();
        let filter = EnvFilter::try_new(directive).unwrap();

        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(filter),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::debug!(target: "russh", "packet cipher internals");
        });

        read(&dir.path().join("termihub-agent.log")).contains("packet cipher internals")
    }

    #[test]
    fn the_default_file_directive_clamps_russh() {
        assert!(
            !russh_debug_reaches_file(FILE_LOG_DIRECTIVE),
            "russh DEBUG is per-packet cipher logging and must never reach a durable file"
        );
    }

    #[test]
    fn raising_file_detail_does_not_unclamp_russh() {
        // The realistic support instruction: "set TERMIHUB_AGENT_FILE_LOG=debug".
        // It must raise the agent's own detail without dragging SSH packet
        // internals into a durable file on the remote host.
        assert!(
            !russh_debug_reaches_file(&format!("{RUSSH_CLAMP},debug")),
            "TERMIHUB_AGENT_FILE_LOG=debug must not silently enable russh packet logging"
        );
    }

    #[test]
    fn an_explicit_russh_directive_still_wins() {
        // Escape hatch: a case that truly needs russh internals can ask.
        assert!(
            russh_debug_reaches_file(&format!("{RUSSH_CLAMP},debug,russh=debug")),
            "an explicit russh=debug must still be honored — the clamp is a default, \
             not a prohibition"
        );
    }

    #[test]
    fn log_dir_is_a_logs_subdir_of_the_agent_config_dir() {
        let cfg = PathBuf::from("/some/agent/config");
        assert_eq!(log_dir_in(cfg.clone()), cfg.join("logs"));
    }

    #[test]
    fn log_dir_sits_under_the_agent_config_dir() {
        use crate::state::persistence::AgentState;
        let dir = log_dir();
        assert!(
            dir.ends_with("logs"),
            "log dir {dir:?} must be a logs/ subdir"
        );
        assert_eq!(
            dir.parent().map(Path::to_path_buf),
            Some(AgentState::config_dir()),
            "the log dir must sit next to state.json under the agent config dir"
        );
    }

    #[test]
    fn log_file_path_sits_inside_the_log_dir() {
        let path = log_file_path();
        assert_eq!(path.file_name().unwrap(), "termihub-agent.log");
        assert_eq!(path.parent().unwrap(), log_dir());
    }

    #[test]
    fn file_filter_keeps_info_and_drops_debug() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 1 << 20, 3).unwrap();

        // Exercise the real default directive (env-free path).
        let filter = EnvFilter::new(FILE_LOG_DIRECTIVE);
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(filter),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "termihub_agent::session", "session opened");
            tracing::debug!(target: "termihub_agent::session", "per-event noise");
        });

        let contents = read(&dir.path().join("termihub-agent.log"));
        assert!(
            contents.contains("session opened"),
            "INFO must reach the file, got: {contents:?}"
        );
        assert!(
            !contents.contains("per-event noise"),
            "DEBUG must not reach the file — it is what drowns a readable log; got: {contents:?}"
        );
    }
}
