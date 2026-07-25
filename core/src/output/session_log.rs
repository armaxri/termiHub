//! Per-session output logging to a file (#1960).
//!
//! termiHub keeps a 1 MiB scrollback ring per session and a rotating app
//! diagnostics log, but neither is a durable transcript of a session's output:
//! when a tab closes the evidence is gone. This module adds the missing piece —
//! an opt-in per-session sink that mirrors every output byte the core already
//! sees ([`crate::output::coalescer`] / the session output reader) into a file,
//! the way PuTTY / Termius / iTerm log sessions.
//!
//! # Design notes
//!
//! **Timestamps are injected, not computed here.** Producing a wall-clock
//! timestamp string means pulling in a date library, and the core crate is
//! deliberately dependency-light. So [`SessionLogger`] takes a [`Clock`]
//! closure that returns the timestamp string; the desktop wires in a
//! `chrono`-based clock, and tests inject a fixed one for deterministic output.
//!
//! **Synchronous, line-buffered writes.** Output volume for an interactive
//! session is modest, and a durable transcript must not lose its tail if the
//! process dies — so writes go straight through a [`BufWriter`] that is flushed
//! on close (and on [`Drop`]), rather than through a background channel that a
//! crash would discard.
//!
//! **Per-line timestamping is opt-in and line-boundary aware.** Raw PTY output
//! arrives in arbitrary chunks; a single logical line can straddle two writes.
//! The logger tracks whether it is at the start of a line so a timestamp is
//! emitted once per line, never mid-line, regardless of how the bytes were
//! chunked.
//!
//! **Size-based rotation gives a hard ceiling.** When the active file grows past
//! [`SessionLogConfig::max_bytes`] it is rolled to a single `<name>.1` archive,
//! bounding on-disk use at roughly `2 × max_bytes` per session without depending
//! on how long the session runs.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

/// Default size at which the active log file is rolled to an archive (50 MiB).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// A clock returning the current timestamp string for per-line prefixes.
///
/// Injected so the core crate needs no date dependency and tests stay
/// deterministic. The desktop supplies a `chrono`-formatted clock.
pub type Clock = Box<dyn Fn() -> String + Send>;

/// Configuration for opening a [`SessionLogger`].
#[derive(Debug, Clone)]
pub struct SessionLogConfig {
    /// Destination file path. Parent directories are created if absent.
    pub path: PathBuf,
    /// When `true`, each output line is prefixed with `[<timestamp>] `.
    pub timestamps: bool,
    /// When `true`, an existing file is appended to; otherwise it is truncated.
    pub append: bool,
    /// Roll the active file to `<name>.1` once it exceeds this many bytes.
    pub max_bytes: u64,
}

impl SessionLogConfig {
    /// Build a config for `path` with sensible defaults (append, 50 MiB cap).
    pub fn new(path: impl Into<PathBuf>, timestamps: bool) -> Self {
        Self {
            path: path.into(),
            timestamps,
            append: true,
            max_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }
}

/// A per-session output-to-file sink.
///
/// Write raw session output with [`write`](Self::write); the logger handles
/// optional per-line timestamping, size-based rotation, and flushing. Bytes are
/// flushed to the OS on [`flush`](Self::flush) and on [`Drop`].
pub struct SessionLogger {
    writer: BufWriter<File>,
    path: PathBuf,
    timestamps: bool,
    max_bytes: u64,
    /// Whether the next byte written begins a new line (drives timestamp
    /// prefixing across chunk boundaries).
    at_line_start: bool,
    /// Bytes written to the current active file (reset on rotation).
    bytes_written: u64,
    clock: Clock,
}

impl SessionLogger {
    /// Open (or create) the log file described by `config`.
    ///
    /// `clock` supplies the per-line timestamp string; it is only invoked when
    /// `config.timestamps` is `true`. Creates any missing parent directories.
    pub fn open(config: SessionLogConfig, clock: Clock) -> io::Result<Self> {
        if let Some(parent) = config.path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }

        let mut opts = OpenOptions::new();
        opts.create(true).write(true);
        if config.append {
            opts.append(true);
        } else {
            opts.truncate(true);
        }
        let file = opts.open(&config.path)?;
        let bytes_written = file.metadata().map(|m| m.len()).unwrap_or(0);

        Ok(Self {
            writer: BufWriter::new(file),
            path: config.path,
            timestamps: config.timestamps,
            max_bytes: config.max_bytes.max(1),
            // A freshly appended-to file that does not end in a newline is still
            // mid-line, but treating the first write as a line start is the safe
            // and predictable choice for a transcript.
            at_line_start: true,
            bytes_written,
            clock,
        })
    }

    /// The path of the active log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Whether per-line timestamping is enabled for this logger.
    pub fn timestamps_enabled(&self) -> bool {
        self.timestamps
    }

    /// Write raw session output to the log file.
    ///
    /// With timestamps disabled the bytes are written verbatim (an exact
    /// transcript). With timestamps enabled, `[<timestamp>] ` is inserted at the
    /// start of every line — correctly, even when a line spans multiple calls.
    pub fn write(&mut self, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        if self.timestamps {
            self.write_timestamped(data)?;
        } else {
            self.write_raw(data)?;
        }
        if self.bytes_written >= self.max_bytes {
            self.rotate()?;
        }
        Ok(())
    }

    /// Write `data` verbatim, tracking line position and byte count.
    fn write_raw(&mut self, data: &[u8]) -> io::Result<()> {
        self.writer.write_all(data)?;
        self.bytes_written += data.len() as u64;
        self.at_line_start = data.last() == Some(&b'\n');
        Ok(())
    }

    /// Write `data`, prefixing each line with the clock timestamp.
    fn write_timestamped(&mut self, data: &[u8]) -> io::Result<()> {
        for &byte in data {
            if self.at_line_start {
                let prefix = format!("[{}] ", (self.clock)());
                self.writer.write_all(prefix.as_bytes())?;
                self.bytes_written += prefix.len() as u64;
                self.at_line_start = false;
            }
            self.writer.write_all(&[byte])?;
            self.bytes_written += 1;
            if byte == b'\n' {
                self.at_line_start = true;
            }
        }
        Ok(())
    }

    /// Flush buffered bytes to the underlying file.
    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }

    /// Roll the active file to a single `<name>.1` archive and reopen empty.
    ///
    /// Best-effort: the previous archive is replaced. On any filesystem error
    /// the current writer is left intact so logging continues rather than
    /// aborting the session.
    fn rotate(&mut self) -> io::Result<()> {
        self.writer.flush()?;

        let archive = rotated_path(&self.path);
        // Replacing the archive and renaming are best-effort; ignore errors so a
        // rotation hiccup never tears down an active session's logging.
        let _ = fs::remove_file(&archive);
        if fs::rename(&self.path, &archive).is_err() {
            // Could not roll (e.g. cross-device); keep writing to the same file.
            return Ok(());
        }

        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.writer = BufWriter::new(file);
        self.bytes_written = 0;
        self.at_line_start = true;
        Ok(())
    }
}

impl Drop for SessionLogger {
    fn drop(&mut self) {
        // Best-effort final flush so a closed session's tail is not lost.
        let _ = self.writer.flush();
    }
}

/// Compute the archive path for `path` by inserting `.1` before the extension
/// (`app-2026.log` → `app-2026.1.log`; extension-less paths gain a `.1` suffix).
fn rotated_path(path: &Path) -> PathBuf {
    match path.extension() {
        Some(ext) => path.with_extension(format!("1.{}", ext.to_string_lossy())),
        None => {
            let mut s = path.as_os_str().to_os_string();
            s.push(".1");
            PathBuf::from(s)
        }
    }
}

/// Sanitize a connection name into a filesystem-safe filename fragment.
///
/// Path separators, control characters, and characters illegal on common
/// filesystems (including Windows) are replaced with `_`; the result is trimmed
/// and capped so the default filename stays reasonable. Empty or all-invalid
/// input yields `"session"`.
pub fn sanitize_connection_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c if c.is_whitespace() => '_',
            c => c,
        })
        .collect();
    out = out.trim_matches(|c| c == '_' || c == '.').to_string();
    if out.len() > 64 {
        out.truncate(64);
    }
    if out.is_empty() {
        "session".to_string()
    } else {
        out
    }
}

/// Build the default per-session log filename: `<connection>-<timestamp>.log`.
///
/// `connection` is sanitized via [`sanitize_connection_name`]; `timestamp` is a
/// caller-supplied stamp (e.g. `20260725-140302`) so the core stays date-library
/// free and the result is deterministic in tests.
pub fn default_log_filename(connection: &str, timestamp: &str) -> String {
    format!("{}-{}.log", sanitize_connection_name(connection), timestamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixed_clock(stamp: &'static str) -> Clock {
        Box::new(move || stamp.to_string())
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "termihub-session-log-test-{}-{}",
            std::process::id(),
            uuid_like()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Small unique-ish token without pulling `uuid` into the test.
    fn uuid_like() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn raw_write_is_byte_exact() {
        let dir = temp_dir();
        let path = dir.join("raw.log");
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, false), fixed_clock("T")).unwrap();
        logger.write(b"hello\nwo").unwrap();
        logger.write(b"rld\n").unwrap();
        logger.flush().unwrap();

        let contents = fs::read(&path).unwrap();
        assert_eq!(contents, b"hello\nworld\n");
    }

    #[test]
    fn per_line_timestamps_prefix_each_line() {
        let dir = temp_dir();
        let path = dir.join("ts.log");
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, true), fixed_clock("2026-07-25"))
                .unwrap();
        logger.write(b"first\nsecond\n").unwrap();
        logger.flush().unwrap();

        let contents = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert_eq!(contents, "[2026-07-25] first\n[2026-07-25] second\n");
    }

    #[test]
    fn timestamp_not_repeated_when_line_spans_chunks() {
        let dir = temp_dir();
        let path = dir.join("split.log");
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, true), fixed_clock("TS")).unwrap();
        // A single logical line delivered across three writes must get exactly
        // one timestamp, and the next line a fresh one.
        logger.write(b"hel").unwrap();
        logger.write(b"lo").unwrap();
        logger.write(b" world\nnext\n").unwrap();
        logger.flush().unwrap();

        let contents = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        assert_eq!(contents, "[TS] hello world\n[TS] next\n");
    }

    #[test]
    fn no_trailing_timestamp_emitted_for_unterminated_line() {
        let dir = temp_dir();
        let path = dir.join("partial.log");
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, true), fixed_clock("TS")).unwrap();
        logger.write(b"line\n").unwrap();
        logger.write(b"tail-without-newline").unwrap();
        logger.flush().unwrap();

        let contents = String::from_utf8(fs::read(&path).unwrap()).unwrap();
        // No dangling "[TS] " after the final line since no new line started.
        assert_eq!(contents, "[TS] line\n[TS] tail-without-newline");
    }

    #[test]
    fn append_mode_preserves_existing_content() {
        let dir = temp_dir();
        let path = dir.join("append.log");
        fs::write(&path, b"existing\n").unwrap();
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, false), fixed_clock("T")).unwrap();
        logger.write(b"more\n").unwrap();
        logger.flush().unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"existing\nmore\n");
    }

    #[test]
    fn truncate_mode_replaces_existing_content() {
        let dir = temp_dir();
        let path = dir.join("truncate.log");
        fs::write(&path, b"old-content\n").unwrap();
        let mut config = SessionLogConfig::new(&path, false);
        config.append = false;
        let mut logger = SessionLogger::open(config, fixed_clock("T")).unwrap();
        logger.write(b"fresh\n").unwrap();
        logger.flush().unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"fresh\n");
    }

    #[test]
    fn open_creates_missing_parent_directories() {
        let dir = temp_dir();
        let path = dir.join("nested/sub/dir/out.log");
        let mut logger =
            SessionLogger::open(SessionLogConfig::new(&path, false), fixed_clock("T")).unwrap();
        logger.write(b"x").unwrap();
        logger.flush().unwrap();
        assert!(path.exists());
    }

    #[test]
    fn drop_flushes_pending_bytes() {
        let dir = temp_dir();
        let path = dir.join("drop.log");
        {
            let mut logger =
                SessionLogger::open(SessionLogConfig::new(&path, false), fixed_clock("T")).unwrap();
            logger.write(b"buffered-but-not-flushed").unwrap();
            // No explicit flush — Drop must persist it.
        }
        assert_eq!(fs::read(&path).unwrap(), b"buffered-but-not-flushed");
    }

    #[test]
    fn rotation_rolls_to_archive_and_continues() {
        let dir = temp_dir();
        let path = dir.join("rot.log");
        let mut config = SessionLogConfig::new(&path, false);
        config.max_bytes = 8;
        let mut logger = SessionLogger::open(config, fixed_clock("T")).unwrap();

        logger.write(b"12345678").unwrap(); // hits the 8-byte threshold → rotate
        logger.write(b"9").unwrap(); // lands in the fresh active file
        logger.flush().unwrap();

        let archive = rotated_path(&path);
        assert_eq!(fs::read(&archive).unwrap(), b"12345678");
        assert_eq!(fs::read(&path).unwrap(), b"9");
    }

    #[test]
    fn rotated_path_inserts_generation_before_extension() {
        assert_eq!(
            rotated_path(Path::new("/tmp/sess-2026.log")),
            PathBuf::from("/tmp/sess-2026.1.log")
        );
        assert_eq!(
            rotated_path(Path::new("/tmp/sess-no-ext")),
            PathBuf::from("/tmp/sess-no-ext.1")
        );
    }

    #[test]
    fn sanitize_connection_name_replaces_unsafe_chars() {
        assert_eq!(sanitize_connection_name("SSH: user@host"), "SSH__user@host");
        assert_eq!(sanitize_connection_name("a/b\\c:d"), "a_b_c_d");
        assert_eq!(sanitize_connection_name(""), "session");
        assert_eq!(sanitize_connection_name("///"), "session");
    }

    #[test]
    fn default_log_filename_combines_name_and_timestamp() {
        assert_eq!(
            default_log_filename("Serial: /dev/tty", "20260725-140302"),
            "Serial___dev_tty-20260725-140302.log"
        );
    }
}
