//! The shared durable log-file writer for the desktop and the agent (#4319).
//!
//! Both termiHub processes keep a size-rotating, count-capped log file — the
//! desktop's `termihub.log` (#1570) and the agent's per-process
//! `termihub-agent-<role>-<pid>.log` (audit OBS-003). Each crate owns only *where*
//! its log lives and which env var overrides its filter; the writer, the
//! rotation, the per-directory budget and the `russh` clamp live here, once
//! (audit DUP2-006).
//!
//! # Design notes
//!
//! **Why synchronous writes, not `tracing_appender::non_blocking`?** The
//! non-blocking writer hands events to a background thread over a channel. When
//! the process dies abruptly — SIGKILL, jetsam, OOM, panic — whatever is still in
//! that channel is lost, and the lost tail is exactly what a post-mortem needs.
//! At INFO volume the cost of writing straight through is irrelevant.
//!
//! **Why not a rotation crate?** Candidates were evaluated (#4319):
//!
//! - `tracing-appender`'s rolling appender rotates by *time*; `max_log_files`
//!   bounds the file count, not their size, so one runaway day still writes an
//!   unbounded file.
//! - `file-rotate` (size-based) panics (`expect("create dir")`) when the log
//!   directory cannot be created — the agent must instead fall back to stderr on
//!   a read-only home — and silently drops every write when the file cannot be
//!   reopened. It also renames archives to `name.log.N`, which would move the
//!   documented `termihub.1.log` names.
//! - None of them handles another process (or another writer) renaming or
//!   deleting the live file underneath an open handle, which is the bug class
//!   behind audit OBS2-002.
//!
//! So the rotator stays custom, but in one place.
//!
//! **Per-process files.** Several agent processes run at once on one host
//! (`--stdio` workers, one `--daemon` per persistent session, the
//! `--registry-daemon`). Sharing one rotating file across them sent lines into
//! renamed or deleted archives (OBS2-002), so every agent process now writes its
//! own file ([`per_process_stem`]), and a [`FamilyBudget`] bounds the whole
//! directory. As a second line of defence the writer re-checks, before every
//! event, that its handle still is the file at its path and reopens it if not —
//! so a file pruned or rotated away by someone else never swallows a line.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// Extension of every log file.
pub const LOG_EXT: &str = "log";

/// Floor applied to `russh` on top of *any* file directive, including an
/// env-var override.
///
/// `russh` emits per-packet cipher logs below WARN. A durable log file is
/// written to disk and pasted into issues, so packet-level SSH internals must
/// not reach it by accident — e.g. through `TERMIHUB_FILE_LOG=debug`, which
/// should raise termiHub's own detail only. A case that genuinely needs russh
/// internals can still ask explicitly (`"debug,russh=debug"`): later directives
/// win in an [`EnvFilter`].
pub const RUSSH_CLAMP: &str = "russh=warn";

/// Default filter directive for a file sink: INFO and above, russh clamped.
pub const DEFAULT_FILE_DIRECTIVE: &str = "info,russh=warn";

/// `directive` with [`RUSSH_CLAMP`] prepended, so russh stays at WARN unless the
/// directive names it explicitly.
pub fn russh_clamped(directive: &str) -> String {
    format!("{RUSSH_CLAMP},{directive}")
}

/// The [`EnvFilter`] for a file sink.
///
/// A non-blank `override_directive` (an env-var value) is used with
/// [`RUSSH_CLAMP`] prepended; a blank or unparsable one falls back to
/// [`DEFAULT_FILE_DIRECTIVE`].
pub fn file_env_filter(override_directive: Option<&str>) -> EnvFilter {
    override_directive
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .and_then(|d| EnvFilter::try_new(russh_clamped(d)).ok())
        .unwrap_or_else(|| EnvFilter::new(DEFAULT_FILE_DIRECTIVE))
}

/// The file stem of one process's own log: `<prefix>-<role>-<pid>`.
pub fn per_process_stem(prefix: &str, role: &str, pid: u32) -> String {
    format!("{prefix}-{role}-{pid}")
}

/// Path of generation `generation` of the log `stem` in `dir`: 0 is the live
/// file (`stem.log`), 1..n the archives (`stem.N.log`).
pub fn generation_path(dir: &Path, stem: &str, generation: usize) -> PathBuf {
    if generation == 0 {
        dir.join(format!("{stem}.{LOG_EXT}"))
    } else {
        dir.join(format!("{stem}.{generation}.{LOG_EXT}"))
    }
}

/// Split a log file name into its stem and generation, if it is one.
fn parse_log_name(name: &str) -> Option<(&str, usize)> {
    let base = name.strip_suffix(&format!(".{LOG_EXT}"))?;
    match base.rsplit_once('.') {
        Some((stem, digits))
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) =>
        {
            Some((stem, digits.parse().ok()?))
        }
        _ => Some((base, 0)),
    }
}

/// Whether `stem` belongs to the log family `prefix`: the stem itself, or any
/// `prefix-…` per-process / per-role stem.
fn in_family(stem: &str, prefix: &str) -> bool {
    stem == prefix
        || stem
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('-') && rest.len() > 1)
}

/// Every log file of the family `prefix` in `dir` (live files and archives of
/// `prefix` itself and of every `prefix-…` stem), regular files only.
///
/// Ordered for display: the bare `prefix` stem first, then the other stems by
/// name, each stem's generations newest (live) first. A missing or unreadable
/// directory yields nothing.
pub fn family_files(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(bool, String, usize, PathBuf)> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let (stem, generation) = parse_log_name(&name)?;
            in_family(stem, prefix)
                .then(|| (stem != prefix, stem.to_string(), generation, e.path()))
        })
        .collect();
    found.sort_by(|a, b| (a.0, &a.1, a.2).cmp(&(b.0, &b.1, b.2)));
    found.into_iter().map(|(_, _, _, path)| path).collect()
}

/// A bound on a whole log family in one directory, across every process that
/// writes into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyBudget {
    /// The family's stem prefix (see [`family_files`]).
    pub prefix: String,
    /// Most bytes all family files may use together.
    pub max_total_bytes: u64,
    /// Most family files kept.
    pub max_files: usize,
}

/// Delete family files until the family fits `max_total_bytes` and `max_files`.
///
/// `keep` (the caller's own files) is never deleted but counts toward the
/// budget. Archives go before live files, and the oldest (by modification time)
/// first within each — so a quiet, long-lived process keeps its current file
/// the longest. Best-effort: a file that cannot be removed is skipped.
pub fn prune_family(
    dir: &Path,
    prefix: &str,
    keep: &[PathBuf],
    max_total_bytes: u64,
    max_files: usize,
) {
    struct Member {
        path: PathBuf,
        len: u64,
        archive: bool,
        modified: SystemTime,
    }
    let members: Vec<Member> = family_files(dir, prefix)
        .into_iter()
        .filter_map(|path| {
            let meta = fs::metadata(&path).ok()?;
            let archive = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(parse_log_name)
                .is_some_and(|(_, generation)| generation > 0);
            Some(Member {
                len: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                archive,
                path,
            })
        })
        .collect();

    let mut total: u64 = members.iter().map(|m| m.len).sum();
    let mut count = members.len();
    let mut candidates: Vec<&Member> = members.iter().filter(|m| !keep.contains(&m.path)).collect();
    candidates.sort_by_key(|m| (!m.archive, m.modified));

    for member in candidates {
        if total <= max_total_bytes && count <= max_files {
            break;
        }
        if fs::remove_file(&member.path).is_ok() {
            total = total.saturating_sub(member.len);
            count -= 1;
        }
    }
}

/// Open `path` for appending as a capped capture file (e.g. a detached daemon's
/// stderr), truncating it first if it is already larger than `cap`.
///
/// Opened in append mode so that [`enforce_cap`] can later truncate it under a
/// live writer without leaving a hole: the next write lands at the new end.
pub fn open_capped(path: &Path, cap: u64) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // Truncate through a separate write handle: on Windows an append-only
    // handle lacks the write-data access that setting the length needs.
    if fs::metadata(path).is_ok_and(|m| m.len() > cap) {
        File::create(path)?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Truncate `file` to empty if it has grown past `cap`. Returns whether it did.
///
/// A no-op for anything that is not a regular file (a pipe, a tty, `/dev/null`),
/// so it is safe to point at an inherited stderr. `file` needs write access
/// (on unix any writable descriptor, including an append-mode one).
pub fn enforce_cap(file: &File, cap: u64) -> io::Result<bool> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() <= cap {
        return Ok(false);
    }
    file.set_len(0)?;
    Ok(true)
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
    /// Open (or create) `dir/stem.log`, rotating at `max_bytes` and keeping at
    /// most `max_files` generations in total.
    ///
    /// Appends to an existing file so a restart does not discard the previous
    /// run — the run boundary is marked by the startup banner instead.
    pub fn new(
        dir: impl AsRef<Path>,
        stem: &str,
        max_bytes: u64,
        max_files: usize,
    ) -> io::Result<Self> {
        let rotator = Rotator::open(
            dir.as_ref().to_path_buf(),
            stem.to_string(),
            max_bytes,
            max_files.max(1),
        )?;
        Ok(Self {
            inner: Arc::new(Mutex::new(rotator)),
        })
    }

    /// Bound the whole log family in this file's directory by `budget`, pruning
    /// now and after every rotation (see [`prune_family`]).
    pub fn with_family_budget(self, budget: FamilyBudget) -> Self {
        {
            let mut rotator = self.lock();
            rotator.budget = Some(budget);
            rotator.prune();
        }
        self
    }

    /// Path of the live (un-rotated) file.
    pub fn path(&self) -> PathBuf {
        self.lock().path(0)
    }

    fn lock(&self) -> MutexGuard<'_, Rotator> {
        // A poisoned lock means some other thread panicked mid-write. Losing the
        // log at exactly that moment is the opposite of what this is for, so
        // recover the guard and keep writing.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl<'a> MakeWriter<'a> for RotatingLogFile {
    type Writer = LockedRotator<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        LockedRotator(self.lock())
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

/// What identifies the file an open handle refers to, so a rename or delete of
/// the path underneath it can be detected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}

impl FileIdentity {
    fn of(meta: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                dev: meta.dev(),
                ino: meta.ino(),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                created: meta.created().ok(),
            }
        }
    }
}

/// The rotation state machine. Not public: all access goes through the lock.
struct Rotator {
    dir: PathBuf,
    stem: String,
    file: File,
    identity: FileIdentity,
    /// Bytes in the live file, refreshed from the path before every write.
    written: u64,
    max_bytes: u64,
    max_files: usize,
    budget: Option<FamilyBudget>,
}

impl Rotator {
    fn open(dir: PathBuf, stem: String, max_bytes: u64, max_files: usize) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        let path = generation_path(&dir, &stem, 0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let meta = file.metadata()?;
        Ok(Self {
            identity: FileIdentity::of(&meta),
            written: meta.len(),
            dir,
            stem,
            file,
            max_bytes,
            max_files,
            budget: None,
        })
    }

    fn path(&self, generation: usize) -> PathBuf {
        generation_path(&self.dir, &self.stem, generation)
    }

    fn own_files(&self) -> Vec<PathBuf> {
        (0..self.max_files).map(|g| self.path(g)).collect()
    }

    fn prune(&self) {
        if let Some(budget) = &self.budget {
            prune_family(
                &self.dir,
                &budget.prefix,
                &self.own_files(),
                budget.max_total_bytes,
                budget.max_files,
            );
        }
    }

    /// (Re)open the live file in append mode and adopt its identity and size.
    fn reopen(&mut self, truncate: bool) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create(true);
        if truncate {
            options.write(true).truncate(true);
        } else {
            options.append(true);
        }
        let file = options.open(self.path(0))?;
        let meta = file.metadata()?;
        self.identity = FileIdentity::of(&meta);
        self.written = meta.len();
        self.file = file;
        Ok(())
    }

    /// Make sure the handle still is the file at the live path — another writer
    /// may have rotated it away, or a family prune deleted it — and refresh the
    /// size from the path, which also counts other writers' appends.
    fn follow_live_path(&mut self) -> io::Result<()> {
        match fs::metadata(self.path(0)) {
            Ok(meta) if self.same_file(&meta) => {
                self.written = meta.len();
                Ok(())
            }
            Ok(_) => self.reopen(false),
            Err(e) if e.kind() == io::ErrorKind::NotFound => self.reopen(false),
            Err(e) => Err(e),
        }
    }

    fn same_file(&self, path_meta: &fs::Metadata) -> bool {
        if FileIdentity::of(path_meta) != self.identity {
            return false;
        }
        // Without inodes, a creation time alone can be reused by the platform
        // (Windows file-name tunneling), so the size must agree too.
        #[cfg(not(unix))]
        {
            self.file
                .metadata()
                .is_ok_and(|own| own.len() == path_meta.len())
        }
        #[cfg(unix)]
        {
            true
        }
    }

    /// Shift every generation one older, dropping the oldest, and start a fresh
    /// live file.
    fn rotate(&mut self) -> io::Result<()> {
        let archives = self.max_files - 1;
        if archives == 0 {
            // Degenerate cap of one file: truncate in place.
            return self.reopen(true);
        }

        // Drop the oldest, then walk backwards so nothing overwrites a file we
        // still need.
        let _ = fs::remove_file(self.path(archives));
        for generation in (1..archives).rev() {
            let _ = fs::rename(self.path(generation), self.path(generation + 1));
        }
        let _ = fs::rename(self.path(0), self.path(1));
        self.reopen(false)?;
        self.prune();
        Ok(())
    }
}

impl Write for Rotator {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Best-effort: if the live path cannot be checked or reopened, keep
        // writing to the current handle rather than dropping the event.
        let _ = self.follow_live_path();
        // Rotate *before* writing so a single event is never split across two
        // files. `written > 0` keeps an event larger than the cap from spinning
        // the rotation on an already-empty file.
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
#[path = "file_log_tests.rs"]
mod tests;
