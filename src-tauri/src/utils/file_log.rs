//! Persistent application log file (#1570).
//!
//! termiHub historically kept its log only in memory: the [`LogCaptureLayer`]
//! ring buffer feeds the in-app LogViewer, and the `fmt` layer writes to stdout
//! — which is discarded for a bundled desktop app. The moment the process was
//! gone, so was every trace of what it had been doing. A post-mortem of the
//! 2026-07-17 shutdown had to be reconstructed entirely from Apple's unified
//! log and jetsam snapshots because termiHub itself left nothing behind.
//!
//! This module adds the missing durable sink: a rotating, hard-capped log file
//! in the platform's conventional location.
//!
//! # Design notes
//!
//! **Why not `tauri-plugin-log`?** The issue suggested it, but the app already
//! owns a full `tracing` pipeline (filter + fmt + ring buffer). The plugin
//! builds a second, parallel logging system on the `log` crate; every event
//! would need bridging and the two would drift. Adding one more `Layer` to the
//! registry that already exists is both smaller and keeps a single source of
//! truth.
//!
//! **Why synchronous writes, not `tracing_appender::non_blocking`?** The
//! non-blocking writer hands events to a background thread over a channel. When
//! the process dies abruptly — SIGKILL, jetsam, panic — whatever is still in
//! that channel is lost. The lost tail is exactly the part a post-mortem needs.
//! At INFO volume the cost of writing straight through is irrelevant, so this
//! writer trades throughput we do not need for the durability that is the whole
//! point of the feature.
//!
//! **Why a custom rotator?** `tracing-appender`'s rotation is time-based
//! (`max_log_files` bounds the file *count*, not their size), so a single
//! runaway day — a reconnect loop, say — could still write an unbounded file.
//! Size-based rotation gives a hard ceiling that does not depend on how the app
//! behaves: at most [`MAX_FILE_BYTES`] × [`MAX_FILES`] on disk, always.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// The app's bundle identifier, matching `tauri.conf.json`.
///
/// Used to build the platform log directory. Kept in sync with the bundle id by
/// [`tests::log_dir_matches_platform_convention`].
const BUNDLE_ID: &str = "com.termihub.app";

/// Base name of the current log file (`termihub.log`).
const LOG_STEM: &str = "termihub";

/// Extension of the log files.
const LOG_EXT: &str = "log";

/// Size at which the current log file is rotated away.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// Total number of log files kept: the current one plus `MAX_FILES - 1`
/// archives. Together with [`MAX_FILE_BYTES`] this bounds on-disk usage at
/// 15 MiB.
const MAX_FILES: usize = 3;

/// Filter directive for the *file* sink.
///
/// Deliberately stricter than the ring buffer's directive (which keeps
/// termiHub's crates at DEBUG so the in-app LogViewer stays useful). A file a
/// user is expected to read — and paste into an issue — must not drown in
/// per-keystroke debug spam, so the file keeps INFO and above. `RUST_LOG` is
/// intentionally *not* honored here: it tunes the interactive LogViewer, and
/// having it silently change what lands on disk would make the file's contents
/// depend on how the app happened to be launched.
///
/// `TERMIHUB_FILE_LOG` overrides this when a support case needs more detail.
///
/// `russh` is clamped for the same reason the ring buffer clamps it — it emits
/// per-packet cipher logs below WARN — but here the clamp is also a *safety*
/// property, not just a noise one: this file is written to disk and pasted into
/// issues, so packet-level SSH internals must not reach it. See
/// [`RUSSH_CLAMP`], which keeps that true even when the override lowers the level.
const FILE_LOG_DIRECTIVE: &str = "info,russh=warn";

/// Floor applied to `russh` on top of *any* file directive, including a
/// `TERMIHUB_FILE_LOG` override.
///
/// Without this, `TERMIHUB_FILE_LOG=debug` would silently unclamp russh's
/// per-packet cipher logging into a durable, user-shared file. A support case
/// that genuinely needs russh internals can still ask for them explicitly
/// (`TERMIHUB_FILE_LOG="debug,russh=debug"`) — the point is that it cannot
/// happen by accident while someone is only trying to raise termiHub's own detail.
const RUSSH_CLAMP: &str = "russh=warn";

/// Build the [`EnvFilter`] for the file sink.
///
/// Honors `TERMIHUB_FILE_LOG` when set, else [`FILE_LOG_DIRECTIVE`]. An override
/// gets [`RUSSH_CLAMP`] prepended, so a directive that names `russh` explicitly
/// still wins (later directives take precedence in an `EnvFilter`) while one that
/// does not stays clamped.
pub fn file_env_filter() -> EnvFilter {
    match std::env::var("TERMIHUB_FILE_LOG") {
        Ok(directive) if !directive.trim().is_empty() => {
            EnvFilter::try_new(format!("{RUSSH_CLAMP},{directive}"))
                .unwrap_or_else(|_| EnvFilter::new(FILE_LOG_DIRECTIVE))
        }
        _ => EnvFilter::new(FILE_LOG_DIRECTIVE),
    }
}

/// Resolve the directory the application log is written to.
///
/// Follows each platform's own convention rather than inventing one — notably
/// on macOS this is `~/Library/Logs/<bundle-id>/`, which is where the #1570
/// investigator looked and found nothing. These paths match Tauri's own
/// `app_log_dir()` resolution, but are computed here because the subscriber is
/// initialized before the Tauri app exists.
///
/// - macOS: `~/Library/Logs/com.termihub.app`
/// - Windows: `%LOCALAPPDATA%\com.termihub.app\logs`
/// - Linux: `$XDG_DATA_HOME/com.termihub.app/logs` (i.e. `~/.local/share/...`)
///
/// Returns `None` when the platform base directory cannot be resolved, in which
/// case file logging is skipped rather than guessed at.
pub fn log_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library").join("Logs").join(BUNDLE_ID))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|d| d.join(BUNDLE_ID).join("logs"))
    }
}

/// Full path of the current (un-rotated) log file, for reporting to the user.
pub fn log_file_path() -> Option<PathBuf> {
    log_dir().map(|d| d.join(format!("{LOG_STEM}.{LOG_EXT}")))
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
    /// run — the run boundary is marked by the startup banner instead.
    pub fn new(dir: impl AsRef<Path>, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        let rotator = Rotator::open(dir.as_ref().to_path_buf(), max_bytes, max_files.max(1))?;
        Ok(Self {
            inner: Arc::new(Mutex::new(rotator)),
        })
    }

    /// Open the log file at the platform's conventional location with the
    /// default size and count caps.
    pub fn with_defaults() -> io::Result<Self> {
        let dir = log_dir().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "could not resolve a platform log directory",
            )
        })?;
        Self::new(dir, MAX_FILE_BYTES, MAX_FILES)
    }
}

impl<'a> MakeWriter<'a> for RotatingLogFile {
    type Writer = LockedRotator<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        // A poisoned lock means some other thread panicked mid-write. Losing
        // the log at exactly that moment is the opposite of what this module is
        // for, so recover the guard and keep writing.
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

    /// Path of log generation `gen`: 0 is the live file, 1..n the archives.
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

        assert_eq!(read(&dir.path().join("termihub.log")), "hello\n");
    }

    #[test]
    fn creates_the_log_directory_if_absent() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("deep").join("nested");

        RotatingLogFile::new(&nested, 1024, 3).unwrap();

        assert!(nested.join("termihub.log").exists());
    }

    #[test]
    fn reopening_appends_rather_than_truncating() {
        let dir = tempfile::tempdir().unwrap();

        let first = RotatingLogFile::new(dir.path(), 1024, 3).unwrap();
        first.make_writer().write_all(b"run one\n").unwrap();
        drop(first);

        let second = RotatingLogFile::new(dir.path(), 1024, 3).unwrap();
        second.make_writer().write_all(b"run two\n").unwrap();

        assert_eq!(read(&dir.path().join("termihub.log")), "run one\nrun two\n");
    }

    #[test]
    fn rotates_once_the_size_cap_is_exceeded() {
        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 10, 3).unwrap();

        log.make_writer().write_all(b"aaaaa\n").unwrap(); // 6 bytes, fits
        log.make_writer().write_all(b"bbbbb\n").unwrap(); // would be 12 > 10

        assert_eq!(
            read(&dir.path().join("termihub.log")),
            "bbbbb\n",
            "the live file should hold only the post-rotation write"
        );
        assert_eq!(
            read(&dir.path().join("termihub.1.log")),
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
            read(&dir.path().join("termihub.log")),
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
        assert!(dir.path().join("termihub.log").exists());
        assert!(dir.path().join("termihub.1.log").exists());
        assert!(dir.path().join("termihub.2.log").exists());
        assert!(
            !dir.path().join("termihub.3.log").exists(),
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

        assert_eq!(read(&dir.path().join("termihub.log")), "bbbbb\n");
        assert!(!dir.path().join("termihub.1.log").exists());
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

        read(&dir.path().join("termihub.log")).contains("packet cipher internals")
    }

    #[test]
    fn the_default_file_directive_clamps_russh() {
        assert!(
            !russh_debug_reaches_file(FILE_LOG_DIRECTIVE),
            "russh DEBUG is per-packet cipher logging and must never reach a file \
             users paste into issues"
        );
    }

    #[test]
    fn raising_file_detail_does_not_unclamp_russh() {
        // The realistic support instruction: "set TERMIHUB_FILE_LOG=debug". It must
        // raise termiHub's own detail without dragging SSH packet internals along.
        assert!(
            !russh_debug_reaches_file(&format!("{RUSSH_CLAMP},debug")),
            "TERMIHUB_FILE_LOG=debug must not silently enable russh packet logging"
        );
    }

    #[test]
    fn an_explicit_russh_directive_still_wins() {
        // Escape hatch: a support case that truly needs russh internals can ask.
        assert!(
            russh_debug_reaches_file(&format!("{RUSSH_CLAMP},debug,russh=debug")),
            "an explicit russh=debug must still be honored — the clamp is a default, \
             not a prohibition"
        );
    }

    #[test]
    fn log_dir_matches_platform_convention() {
        let dir = log_dir().expect("a platform log directory should resolve on test hosts");

        assert!(
            dir.ends_with(BUNDLE_ID) || dir.ends_with(Path::new(BUNDLE_ID).join("logs")),
            "log dir {dir:?} must be namespaced by the bundle id"
        );

        #[cfg(target_os = "macos")]
        assert!(
            dir.ends_with(Path::new("Library").join("Logs").join(BUNDLE_ID)),
            "macOS must use ~/Library/Logs/<bundle-id>, got {dir:?}"
        );

        #[cfg(not(target_os = "macos"))]
        assert!(
            dir.ends_with(Path::new(BUNDLE_ID).join("logs")),
            "non-macOS platforms must use <local-data>/<bundle-id>/logs, got {dir:?}"
        );
    }

    #[test]
    fn log_file_path_sits_inside_the_log_dir() {
        let path = log_file_path().unwrap();
        assert_eq!(path.file_name().unwrap(), "termihub.log");
        assert_eq!(path.parent().unwrap(), log_dir().unwrap());
    }

    #[test]
    fn file_filter_keeps_info_and_drops_debug() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::Layer as _;

        let dir = tempfile::tempdir().unwrap();
        let log = RotatingLogFile::new(dir.path(), 1 << 20, 3).unwrap();

        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(log.clone())
                .with_filter(file_env_filter()),
        );
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "termihub_lib::session", "session opened");
            tracing::debug!(target: "termihub_lib::session", "per-keystroke noise");
        });

        let contents = read(&dir.path().join("termihub.log"));
        assert!(
            contents.contains("session opened"),
            "INFO must reach the file, got: {contents:?}"
        );
        assert!(
            !contents.contains("per-keystroke noise"),
            "DEBUG must not reach the file — it is what drowns a readable log; got: {contents:?}"
        );
    }
}
