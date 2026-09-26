//! Local crash reports: write, list, bound, and "notify once" (OBS-010).
//!
//! A panic hook (desktop `utils::panic_hook`, agent `panic_hook`) calls
//! [`write_report`] to leave one small, redacted text file per crash in a
//! `crash-reports/` directory next to the app's log. The directory is bounded by
//! both **count** ([`MAX_REPORTS`]) and **age** ([`MAX_REPORT_AGE`]) via
//! [`prune`], so a crash loop can never fill the disk.
//!
//! What a report contains: the app name, version, OS / architecture, a UTC
//! timestamp, the panicking thread and source location, the panic message
//! (capped at [`MAX_MESSAGE_BYTES`]) and a backtrace (capped at
//! [`MAX_BACKTRACE_BYTES`]). Everything is run through [`Redactor`] first. It
//! never contains terminal session content, connection configs, or credentials
//! by construction — only the panic payload, which is size-capped and redacted
//! in case a caller interpolated something it should not have.
//!
//! Nothing here touches the network. The files stay on disk until the user
//! exports them (desktop "Export diagnostics") or they age out.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::redact::Redactor;

/// Name of the crash-report directory inside an app's log directory.
pub const CRASH_DIR_NAME: &str = "crash-reports";

/// Most crash reports kept; older ones are deleted first.
pub const MAX_REPORTS: usize = 10;

/// Oldest crash report kept (30 days).
pub const MAX_REPORT_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Cap on the panic message, so an oversized payload (e.g. a formatted buffer)
/// cannot smuggle bulk data into a report.
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024;

/// Cap on the rendered backtrace.
pub const MAX_BACKTRACE_BYTES: usize = 64 * 1024;

/// File-name prefix / extension of a crash report.
const REPORT_PREFIX: &str = "crash-";
const REPORT_EXT: &str = ".txt";

/// Marker file recording the newest report the user has already been told about.
const NOTIFIED_MARKER: &str = ".notified";

/// The facts a panic hook gathers about one crash.
#[derive(Debug, Clone, Default)]
pub struct CrashDetails {
    /// Which program crashed, e.g. `"termiHub desktop"` / `"termihub-agent"`.
    pub app: String,
    /// The program's version.
    pub version: String,
    /// The panicking thread's name, if it has one.
    pub thread: Option<String>,
    /// `file:line:col` of the panic, if known.
    pub location: Option<String>,
    /// The panic payload.
    pub message: String,
    /// The captured backtrace, rendered.
    pub backtrace: String,
}

/// One crash report on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportEntry {
    /// File name (`crash-20260926T120102Z-4242.txt`).
    pub name: String,
    /// Full path.
    pub path: PathBuf,
    /// Size in bytes.
    pub size: u64,
}

/// The crash-report directory for a given log directory.
pub fn crash_dir_in(log_dir: &Path) -> PathBuf {
    log_dir.join(CRASH_DIR_NAME)
}

/// Render a crash report as redacted text.
pub fn render_report(details: &CrashDetails, now: SystemTime, redactor: &Redactor) -> String {
    let message = truncate(&details.message, MAX_MESSAGE_BYTES);
    let backtrace = truncate(details.backtrace.trim(), MAX_BACKTRACE_BYTES);
    let backtrace = if backtrace.is_empty()
        || backtrace == "disabled backtrace"
        || backtrace == "unsupported backtrace"
    {
        "(not captured)".to_string()
    } else {
        backtrace
    };
    let text = format!(
        "termiHub crash report\n\
         =====================\n\
         app:       {app}\n\
         version:   {version}\n\
         os:        {os} ({family}, {arch})\n\
         time:      {time}\n\
         thread:    {thread}\n\
         location:  {location}\n\
         \n\
         message:\n{message}\n\
         \n\
         backtrace:\n{backtrace}\n\
         \n\
         This report was written locally and never sent anywhere. Hostnames, IP\n\
         addresses, usernames, home paths and anything credential-shaped were\n\
         redacted. Terminal session content is never recorded.\n",
        app = details.app,
        version = details.version,
        os = std::env::consts::OS,
        family = std::env::consts::FAMILY,
        arch = std::env::consts::ARCH,
        time = format_utc(now),
        thread = details.thread.as_deref().unwrap_or("<unnamed>"),
        location = details.location.as_deref().unwrap_or("unknown"),
    );
    redactor.redact(&text)
}

/// Write a crash report into `dir` (created if needed), then prune the
/// directory to its bounds. Returns the written path.
pub fn write_report(
    dir: &Path,
    details: &CrashDetails,
    now: SystemTime,
    redactor: &Redactor,
) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = dir.join(report_file_name(now, std::process::id()));
    fs::write(&path, render_report(details, now, redactor))?;
    // Best-effort: a failed prune must not lose the report just written.
    let _ = prune(dir, MAX_REPORTS, MAX_REPORT_AGE, now);
    Ok(path)
}

/// `crash-YYYYMMDDTHHMMSSZ-<pid>.txt` — sorts chronologically by name.
pub fn report_file_name(now: SystemTime, pid: u32) -> String {
    let stamp: String = format_utc(now)
        .chars()
        .filter(|c| !matches!(c, '-' | ':'))
        .collect();
    format!("{REPORT_PREFIX}{stamp}-{pid}{REPORT_EXT}")
}

/// Every crash report in `dir`, newest first. A missing directory is empty.
pub fn list_reports(dir: &Path) -> Vec<ReportEntry> {
    let Ok(read) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut reports: Vec<ReportEntry> = read
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            if !is_report_name(&name) {
                return None;
            }
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| ReportEntry {
                name,
                path: e.path(),
                size: meta.len(),
            })
        })
        .collect();
    reports.sort_by(|a, b| b.name.cmp(&a.name));
    reports
}

/// Delete reports beyond `max_count` (oldest first) and any older than
/// `max_age` relative to `now`. Returns how many were deleted.
pub fn prune(
    dir: &Path,
    max_count: usize,
    max_age: Duration,
    now: SystemTime,
) -> io::Result<usize> {
    let mut deleted = 0;
    for (index, report) in list_reports(dir).into_iter().enumerate() {
        let too_old = fs::metadata(&report.path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if index >= max_count || too_old {
            fs::remove_file(&report.path)?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// The newest report the user has not yet been notified about, if any.
pub fn pending_notice(dir: &Path) -> Option<ReportEntry> {
    let newest = list_reports(dir).into_iter().next()?;
    let notified = fs::read_to_string(dir.join(NOTIFIED_MARKER)).unwrap_or_default();
    (newest.name.as_str() > notified.trim()).then_some(newest)
}

/// Record that the user has seen every report currently in `dir`.
pub fn acknowledge(dir: &Path) -> io::Result<()> {
    match list_reports(dir).into_iter().next() {
        Some(newest) => fs::write(dir.join(NOTIFIED_MARKER), newest.name),
        None => Ok(()),
    }
}

/// Read one report by file name. Rejects anything that is not a plain report
/// name (no path separators), so a caller cannot read outside `dir`.
pub fn read_report(dir: &Path, name: &str) -> io::Result<String> {
    if !is_report_name(name) || name.contains(['/', '\\']) || name.contains("..") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a crash report name",
        ));
    }
    fs::read_to_string(dir.join(name))
}

fn is_report_name(name: &str) -> bool {
    name.starts_with(REPORT_PREFIX) && name.ends_with(REPORT_EXT)
}

/// Truncate to at most `max` bytes on a char boundary, marking the cut.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… [truncated {} bytes]", &s[..end], s.len() - end)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a system time (UTC).
pub fn format_utc(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-since-epoch → proleptic Gregorian date.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
#[path = "crash_report_tests.rs"]
mod tests;
