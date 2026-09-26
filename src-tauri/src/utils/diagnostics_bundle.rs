//! "Export diagnostics" bundle (OBS-010).
//!
//! Builds a zip the user can attach to a bug report: the recent application log
//! files, the local crash reports, and a version/platform summary — every text
//! run through the shared [`Redactor`] before it is written. The bundle is only
//! ever written to a destination the user picked in a save dialog; nothing is
//! uploaded anywhere.
//!
//! The file list is computed by [`plan_bundle`] so the UI can show exactly what
//! will be included *before* anything is written ([`BundleEntryInfo`]).
//!
//! Deliberately **excluded**: session transcripts (`logs/sessions/`), terminal
//! scrollback, connection/workspace configs, the credential store, and anything
//! else outside the two sources above.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use termihub_core::diagnostics::crash_report::{self, format_utc};
use termihub_core::diagnostics::redact::Redactor;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use super::file_log;

/// Where one bundle entry's content comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleSource {
    /// A file on disk, redacted when written.
    File(PathBuf),
    /// Generated text, redacted when written.
    Text(String),
}

/// One file in the bundle, as shown in the preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleEntryInfo {
    /// Path inside the zip, e.g. `logs/termihub.log`.
    pub name: String,
    /// Size of the source before redaction, in bytes.
    pub size: u64,
    /// Short human description.
    pub description: String,
}

/// A planned bundle entry: what to show and where the bytes come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleEntry {
    /// Preview metadata.
    pub info: BundleEntryInfo,
    /// Content source.
    pub source: BundleSource,
}

/// Build-time facts for `system-info.txt`.
#[derive(Debug, Clone)]
pub struct BuildInfo {
    /// App version.
    pub version: String,
    /// Git commit the binary was built from.
    pub git_hash: String,
    /// Git branch the binary was built from.
    pub build_branch: String,
}

impl BuildInfo {
    /// The running binary's build info.
    pub fn current() -> Self {
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            git_hash: env!("GIT_HASH").to_string(),
            build_branch: env!("TERMIHUB_BUILD_BRANCH").to_string(),
        }
    }
}

const README: &str = "termiHub diagnostics bundle\n\
===========================\n\
\n\
Created locally at your request. termiHub never sends diagnostics anywhere;\n\
share this file only if you choose to (e.g. attach it to a bug report).\n\
\n\
Contents:\n\
  system-info.txt   app version, build and platform\n\
  logs/             the recent termiHub application log files\n\
  crash-reports/    local crash reports, if termiHub has crashed\n\
\n\
Every file was redacted before it was written: passwords, tokens, keys and\n\
other credential-shaped values, host names, IP addresses, usernames and home\n\
directory paths are masked. Terminal session content, session transcripts,\n\
connection settings and the credential store are never included.\n";

/// Compute the bundle's contents from the app log directory.
pub fn plan_bundle(log_dir: Option<&Path>, build: &BuildInfo, now: SystemTime) -> Vec<BundleEntry> {
    let system_info = render_system_info(build, now);
    let mut entries = vec![
        text_entry(
            "README.txt",
            "What this bundle contains",
            README.to_string(),
        ),
        text_entry(
            "system-info.txt",
            "App version, build and platform",
            system_info,
        ),
    ];
    let Some(log_dir) = log_dir else {
        return entries;
    };
    for path in file_log::existing_log_files_in(log_dir) {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            entries.push(file_entry(
                format!("logs/{name}"),
                "Application log",
                path.clone(),
            ));
        }
    }
    let crash_dir = crash_report::crash_dir_in(log_dir);
    for report in crash_report::list_reports(&crash_dir) {
        entries.push(file_entry(
            format!("{}/{}", crash_report::CRASH_DIR_NAME, report.name),
            "Crash report",
            report.path,
        ));
    }
    entries
}

fn text_entry(name: &str, description: &str, text: String) -> BundleEntry {
    BundleEntry {
        info: BundleEntryInfo {
            name: name.to_string(),
            size: text.len() as u64,
            description: description.to_string(),
        },
        source: BundleSource::Text(text),
    }
}

fn file_entry(name: String, description: &str, path: PathBuf) -> BundleEntry {
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    BundleEntry {
        info: BundleEntryInfo {
            name,
            size,
            description: description.to_string(),
        },
        source: BundleSource::File(path),
    }
}

fn render_system_info(build: &BuildInfo, now: SystemTime) -> String {
    format!(
        "termiHub system info\n\
         ====================\n\
         version:       {}\n\
         build commit:  {}\n\
         build branch:  {}\n\
         os:            {}\n\
         os family:     {}\n\
         arch:          {}\n\
         exported at:   {}\n",
        build.version,
        build.git_hash,
        build.build_branch,
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH,
        format_utc(now),
    )
}

/// Write the planned entries into a zip at `dest`, redacting every text.
///
/// Written to a sibling temp file first and renamed into place, so a failure
/// part-way never leaves a truncated bundle at the user's chosen path. A source
/// file that vanished since planning (e.g. rotated away) is skipped.
pub fn write_bundle(
    dest: &Path,
    entries: &[BundleEntry],
    redactor: &Redactor,
) -> io::Result<usize> {
    let tmp = dest.with_extension("zip.partial");
    let result = write_zip(&tmp, entries, redactor);
    match result {
        Ok(count) => {
            fs::rename(&tmp, dest)?;
            Ok(count)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

fn write_zip(path: &Path, entries: &[BundleEntry], redactor: &Redactor) -> io::Result<usize> {
    let mut zip = ZipWriter::new(File::create(path)?);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut written = 0;
    for entry in entries {
        let text = match &entry.source {
            BundleSource::Text(t) => t.clone(),
            BundleSource::File(p) => match fs::read(p) {
                Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            },
        };
        zip.start_file(entry.info.name.as_str(), options)
            .map_err(io::Error::other)?;
        zip.write_all(redactor.redact(&text).as_bytes())?;
        written += 1;
    }
    zip.finish().map_err(io::Error::other)?;
    Ok(written)
}

#[cfg(test)]
#[path = "diagnostics_bundle_tests.rs"]
mod tests;
