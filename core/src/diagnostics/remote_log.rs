//! A log family served to a **remote** reader (#4519).
//!
//! A connected desktop pulls the agent's own log files
//! (`<config>/logs/termihub-agent-….log`) into its Export Diagnostics bundle
//! over `agent.logs.list` / `agent.logs.read`. This module is the shared,
//! file-system half of that: listing the family, validating the names that
//! cross the trust boundary (an RPC param on the agent, an agent reply on the
//! desktop), and reading one listed file bounded and redacted.
//!
//! It mirrors the crash-report path (`crash_report::read_listed_report`,
//! #3574) with one difference: a log's *newest* lines are what a support case
//! needs, so an over-long file keeps its **tail**, not its head.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::file_log::{family_files, in_family, parse_log_name, LOG_EXT};
use super::redact::Redactor;

/// Most log files one listing returns. Matches the agent's family budget
/// (40 files), so a healthy host's whole family fits.
pub const MAX_REMOTE_LOGS: usize = 40;

/// Most bytes of one log file a remote read returns (256 KiB): the file's
/// newest lines, cut on a line boundary.
pub const MAX_REMOTE_LOG_BYTES: u64 = 256 * 1024;

/// Longest log file name accepted across the trust boundary.
pub const MAX_LOG_NAME_LEN: usize = 128;

/// Marker the reader puts in front of a tail-cut log.
pub const TAIL_CUT_MARKER: &str = "… [earlier lines cut by the size cap]\n";

/// One file of a log family on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFileEntry {
    /// File name (`termihub-agent-stdio-4242.log`). Never a path.
    pub name: String,
    /// Full path.
    pub path: PathBuf,
    /// Size in bytes.
    pub size: u64,
    /// Last modification time, when the platform reports one.
    pub modified: Option<SystemTime>,
}

/// Whether `name` is a plain file name of the log family `prefix`: a
/// `prefix….log` / `prefix….N.log` name of that family, printable ASCII
/// letters, digits, `-`, `_` and `.` only, no `..`, and at most
/// [`MAX_LOG_NAME_LEN`] bytes.
///
/// Used on both sides of the trust boundary: the agent checks the name a
/// desktop asks for, and the desktop checks the names an agent reports before
/// turning them into zip entry paths.
pub fn is_plain_log_name(name: &str, prefix: &str) -> bool {
    if name.is_empty()
        || name.len() > MAX_LOG_NAME_LEN
        || name.contains("..")
        || !name.ends_with(&format!(".{LOG_EXT}"))
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return false;
    }
    parse_log_name(name).is_some_and(|(stem, _)| in_family(stem, prefix))
}

/// The log family `prefix` in `dir`, **newest first** (by modification time,
/// then name), at most [`MAX_REMOTE_LOGS`] files, plain names only. Regular
/// files only: a symlink is never listed. A missing directory yields nothing.
pub fn list_family(dir: &Path, prefix: &str) -> Vec<LogFileEntry> {
    let mut entries: Vec<LogFileEntry> = family_files(dir, prefix)
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            if !is_plain_log_name(&name, prefix) {
                return None;
            }
            let meta = fs::symlink_metadata(&path).ok()?;
            meta.is_file().then(|| LogFileEntry {
                name,
                size: meta.len(),
                modified: meta.modified().ok(),
                path,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    entries.truncate(MAX_REMOTE_LOGS);
    entries
}

/// Read one **listed** log file of the family `prefix` in `dir` for a remote
/// reader, at most `max_bytes` of it, redacted with `redactor`.
///
/// `name` must be a plain family name *and* one of the entries the current,
/// capped [`list_family`] returns, so the caller can only ever name a file the
/// listing showed — never a path. An over-long file keeps its newest lines:
/// the tail is cut on a line boundary and prefixed with [`TAIL_CUT_MARKER`].
/// Returns the redacted text and whether it was cut.
pub fn read_listed_log(
    dir: &Path,
    prefix: &str,
    name: &str,
    max_bytes: u64,
    redactor: &Redactor,
) -> io::Result<(String, bool)> {
    if !is_plain_log_name(name, prefix) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a log file name",
        ));
    }
    let Some(entry) = list_family(dir, prefix)
        .into_iter()
        .find(|e| e.name == name)
    else {
        return Err(io::Error::new(io::ErrorKind::NotFound, "no such log file"));
    };
    let (raw, cut) = read_tail(&entry.path, max_bytes)?;
    let redacted = redactor.redact(&raw);
    // Redaction can lengthen a line (`a` → `[host]`), so re-apply the cap.
    let (text, recut) = cap_tail(redacted, max_bytes);
    let truncated = cut || recut;
    if truncated {
        Ok((format!("{TAIL_CUT_MARKER}{text}"), true))
    } else {
        Ok((text, false))
    }
}

/// The last `max_bytes` of the file at `path` (lossily UTF-8 decoded), and
/// whether anything before them was dropped. A cut tail starts on the line
/// after the cut, so no half line is returned.
fn read_tail(path: &Path, max_bytes: u64) -> io::Result<(String, bool)> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len <= max_bytes {
        let mut bytes = Vec::new();
        file.take(max_bytes).read_to_end(&mut bytes)?;
        return Ok((String::from_utf8_lossy(&bytes).into_owned(), false));
    }
    // Read one byte before the window too: when it is a line break the window
    // already starts on a whole line and nothing more is dropped.
    file.seek(SeekFrom::Start(len - max_bytes - 1))?;
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    let Some((&before, window)) = bytes.split_first() else {
        return Ok((String::new(), true));
    };
    let text = String::from_utf8_lossy(window).into_owned();
    Ok(if before == b'\n' {
        (text, true)
    } else {
        (drop_partial_first_line(text), true)
    })
}

/// Keep at most the last `max` bytes of `text`, starting on a whole line (or
/// at least on a char boundary when the kept part holds no line break).
/// Returns the kept text and whether anything was dropped.
pub fn cap_tail(text: String, max: u64) -> (String, bool) {
    let max = usize::try_from(max).unwrap_or(usize::MAX);
    if text.len() <= max {
        return (text, false);
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (drop_partial_first_line(text[start..].to_string()), true)
}

/// Drop everything up to and including the first line break, unless the text
/// holds none (then it is returned as is — better a partial line than none).
fn drop_partial_first_line(text: String) -> String {
    match text.find('\n') {
        Some(i) if i + 1 < text.len() => text[i + 1..].to_string(),
        _ => text,
    }
}

#[cfg(test)]
#[path = "remote_log_tests.rs"]
mod tests;
