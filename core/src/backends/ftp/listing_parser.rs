//! Directory-listing parsers for the FTP backend.
//!
//! FTP servers return directory listings in several formats. This module maps
//! each into the shared [`FileEntry`] used across the app:
//!
//! * **MLSD** — machine-readable facts lines (`type=dir;size=…;modify=…; name`),
//!   parsed by [`parse_mlsd_line`].
//! * **Unix `ls -l`** and **Windows/DOS** `LIST` output, parsed (in that order)
//!   by [`parse_list_line`].
//!
//! Parsing of the `LIST` line formats is delegated to
//! [`suppaftp::list::File`], which covers POSIX (`ls -l`) and DOS lines. MLSD
//! facts lines are parsed here directly (see [`parse_mlsd_line`]) because
//! suppaftp's MLSx parser rejects common real-world output (four-digit
//! `UNIX.mode` values and `type=cdir` / `type=pdir` markers). This module owns
//! the mapping into [`FileEntry`] (ISO-8601 timestamps, POSIX `rwxrwxrwx`
//! permission strings, path joining, symlink handling) plus a byte-level name
//! decode (UTF-8 with a Latin-1 fallback) and the skipping of malformed /
//! `.` / `..` / `total …` lines.

use suppaftp::list::{File as FtpFile, ListParser, PosixPexQuery};

use crate::files::utils::{chrono_from_epoch, format_permissions, writable_from_permissions};
use crate::files::FileEntry;

/// Decode raw listing bytes as UTF-8, falling back to Latin-1 (ISO-8859-1).
///
/// FTP predates a mandatory charset; names may arrive in either encoding. A
/// strict UTF-8 decode is attempted first; on failure every byte is mapped to
/// its Latin-1 code point (`0x00..=0xFF` → `U+0000..=U+00FF`) so no byte is
/// lost to a replacement character.
pub(crate) fn decode_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|&b| b as char).collect(),
    }
}

/// Parse one MLSD facts line (RFC 3659 §7.2) into a [`FileEntry`], rooted at
/// `dir`.
///
/// The line is `fact=value;fact=value;…; name` — a semicolon-separated set of
/// facts, then a single space, then the entry name. Returns `None` for `.` /
/// `..` (including the `type=cdir` / `type=pdir` self/parent entries), empty
/// names, and any entry without a `type` of `dir` / `file` / `link`.
///
/// This is parsed directly (not via [`suppaftp::list::ListParser::parse_mlsd`])
/// because that parser rejects real-world server output: it errors on
/// four-digit `UNIX.mode` values (e.g. ProFTPD's `UNIX.mode=0755`) and on the
/// `type=cdir` / `type=pdir` markers, which would silently drop every entry.
pub(crate) fn parse_mlsd_line(raw: &[u8], dir: &str) -> Option<FileEntry> {
    let line = decode_bytes(raw);

    // Split the trailing " name" off the facts. Per RFC 3659 the name follows
    // the final ';' and a single space.
    let (facts, name) = line.rsplit_once(';')?;
    let name = name.strip_prefix(' ').unwrap_or(name);
    // MLSD reports base names, but MLST (single-entry) echoes the full pathname;
    // reduce to the base name so `FileEntry.name` is always a leaf.
    let name = name.rsplit('/').next().unwrap_or(name);
    if is_ignored_name(name) {
        return None;
    }

    let mut type_val: Option<String> = None;
    let mut size: u64 = 0;
    let mut modified = String::new();
    // MLSD carries machine-readable permissions; default to `rwxrwxrwx` when no
    // `UNIX.mode` fact is present (mirroring the previous behaviour).
    let mut permissions = "rwxrwxrwx".to_string();

    for fact in facts.split(';') {
        let Some((key, value)) = fact.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "type" => type_val = Some(value.to_ascii_lowercase()),
            "size" => size = value.parse().unwrap_or(0),
            "modify" => modified = parse_mlsx_time(value),
            "unix.mode" => {
                if let Ok(mode) = u32::from_str_radix(value.trim(), 8) {
                    permissions = format_permissions(mode & 0o777);
                }
            }
            _ => {}
        }
    }

    // Only real entries: `cdir` / `pdir` (self/parent) and unknown/missing
    // types are skipped.
    let is_directory = match type_val.as_deref() {
        Some("dir") => true,
        Some("file") | Some("link") => false,
        _ => return None,
    };
    // MLSD reports symlinks as `type=link` but carries no target fact, so the
    // target stays `None`.
    let is_symlink = type_val.as_deref() == Some("link");

    let writable = writable_from_permissions(&permissions);
    Some(FileEntry {
        name: name.to_string(),
        path: join_path(dir, name),
        is_directory,
        size,
        modified,
        permissions: Some(permissions),
        writable,
        is_symlink,
        symlink_target: None,
    })
}

/// Reformat an MLSD `modify` fact (`YYYYMMDDHHMMSS`, optionally with a
/// `.fraction`, in UTC per RFC 3659) as an ISO-8601 timestamp. Returns an empty
/// string for values that are not a 14+ digit timestamp.
fn parse_mlsx_time(value: &str) -> String {
    let digits = value.split('.').next().unwrap_or(value);
    if digits.len() < 14 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return String::new();
    }
    format!(
        "{}-{}-{}T{}:{}:{}Z",
        &digits[0..4],
        &digits[4..6],
        &digits[6..8],
        &digits[8..10],
        &digits[10..12],
        &digits[12..14],
    )
}

/// Parse one `LIST` line (Unix `ls -l` first, then Windows/DOS) into a
/// [`FileEntry`] rooted at `dir`.
///
/// Returns `None` for unparseable lines, `total …` summary lines and
/// `.` / `..` entries.
pub(crate) fn parse_list_line(raw: &[u8], dir: &str) -> Option<FileEntry> {
    let decoded = decode_bytes(raw);
    let line = decoded.trim_end_matches(['\r', '\n']);
    // Unix `ls -l` first (the common case), then Windows/DOS. POSIX lines carry
    // real permissions; DOS lines do not.
    if let Ok(file) = ListParser::parse_posix(line) {
        if is_ignored_name(file.name()) {
            return None;
        }
        return Some(entry_from_file(&file, dir, true));
    }
    if let Ok(file) = ListParser::parse_dos(line) {
        if is_ignored_name(file.name()) {
            return None;
        }
        return Some(entry_from_file(&file, dir, false));
    }
    None
}

/// Parse a full MLSD listing (as returned by [`suppaftp`]) into entries,
/// skipping any malformed lines.
pub(crate) fn parse_mlsd(lines: &[String], dir: &str) -> Vec<FileEntry> {
    lines
        .iter()
        .filter_map(|line| parse_mlsd_line(line.as_bytes(), dir))
        .collect()
}

/// Parse a full `LIST` listing (as returned by [`suppaftp`]) into entries,
/// skipping any malformed lines.
pub(crate) fn parse_list(lines: &[String], dir: &str) -> Vec<FileEntry> {
    lines
        .iter()
        .filter_map(|line| parse_list_line(line.as_bytes(), dir))
        .collect()
}

/// Names that are never surfaced as listing entries.
fn is_ignored_name(name: &str) -> bool {
    name.is_empty() || name == "." || name == ".."
}

/// Build the 9-character `rwxrwxrwx` POSIX permission string for `file`.
fn perms_string(file: &FtpFile) -> String {
    let flag = |present: bool, ch: char| if present { ch } else { '-' };
    let mut s = String::with_capacity(9);
    for who in [
        PosixPexQuery::Owner,
        PosixPexQuery::Group,
        PosixPexQuery::Others,
    ] {
        s.push(flag(file.can_read(who), 'r'));
        s.push(flag(file.can_write(who), 'w'));
        s.push(flag(file.can_execute(who), 'x'));
    }
    s
}

/// Render the file's modification time as an ISO-8601 timestamp, or an empty
/// string when the server did not provide one (epoch sentinel).
fn modified_iso(file: &FtpFile) -> String {
    match file.modified().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) if d.as_secs() > 0 => chrono_from_epoch(d.as_secs()),
        _ => String::new(),
    }
}

/// Join a directory path and an entry name with a single `/` separator.
fn join_path(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

/// Convert a parsed [`FtpFile`] into a [`FileEntry`] rooted at `dir`.
///
/// `with_perms` controls whether a permission string is attached: POSIX and
/// MLSD lines carry meaningful permissions, whereas DOS listings do not.
fn entry_from_file(file: &FtpFile, dir: &str, with_perms: bool) -> FileEntry {
    // POSIX/MLSD lines carry a permission string we can derive writability from;
    // DOS lines carry none, so `writable` stays `None` there.
    let permissions = with_perms.then(|| perms_string(file));
    let writable = permissions.as_deref().and_then(writable_from_permissions);
    // A Unix `ls -l` symlink line ends in `-> target`; suppaftp strips that from
    // the name and exposes the target via `symlink()`. Map an empty target (a
    // link line without `-> …`) to `None` so it never surfaces as `""`.
    let symlink_target = file.symlink().and_then(|target| {
        let s = target.to_string_lossy();
        (!s.is_empty()).then(|| s.into_owned())
    });
    FileEntry {
        name: file.name().to_string(),
        path: join_path(dir, file.name()),
        is_directory: file.is_directory(),
        size: file.size() as u64,
        modified: modified_iso(file),
        permissions,
        writable,
        is_symlink: file.is_symlink(),
        symlink_target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A single parser test case over a captured listing line.
    struct Case {
        /// Raw listing line bytes.
        line: &'static [u8],
        /// Expected name, or `None` if the line should be skipped.
        name: Option<&'static str>,
        is_dir: bool,
        size: u64,
        /// Expected ISO-8601 modified timestamp (empty if not parseable).
        modified: &'static str,
        /// Expected permission string, or `None`.
        perms: Option<&'static str>,
        /// Expected writability hint derived from `perms`.
        writable: Option<bool>,
    }

    const DIR: &str = "/pub";

    fn check(entry: Option<FileEntry>, case: &Case) {
        match (case.name, entry) {
            (None, None) => {}
            (None, Some(e)) => panic!("expected line to be skipped, got {e:?}"),
            (Some(expected), None) => {
                panic!("expected entry named {expected:?}, line was skipped")
            }
            (Some(expected), Some(e)) => {
                assert_eq!(e.name, expected, "name");
                assert_eq!(e.path, format!("{DIR}/{expected}"), "path");
                assert_eq!(e.is_directory, case.is_dir, "is_directory for {expected}");
                assert_eq!(e.size, case.size, "size for {expected}");
                assert_eq!(e.modified, case.modified, "modified for {expected}");
                assert_eq!(
                    e.permissions.as_deref(),
                    case.perms,
                    "permissions for {expected}"
                );
                assert_eq!(e.writable, case.writable, "writable for {expected}");
            }
        }
    }

    #[test]
    fn parses_unix_ls_l_lines() {
        let cases = [
            // Directory.
            Case {
                line: b"drwxrwxr-x 1 root  dialout  4096 Nov 5 2018 provola",
                name: Some("provola"),
                is_dir: true,
                size: 4096,
                modified: "2018-11-05T00:00:00Z",
                perms: Some("rwxrwxr-x"),
                writable: Some(true),
            },
            // Regular file.
            Case {
                line: b"-rw-r--r--    1 0        0             1337 Mar 18 2018 config.ini",
                name: Some("config.ini"),
                is_dir: false,
                size: 1337,
                modified: "2018-03-18T00:00:00Z",
                perms: Some("rw-r--r--"),
                writable: Some(true),
            },
            // Name containing spaces.
            Case {
                line: b"-r--r--r--    1 23        23         1234567 Jan 1  2000 01 1234 foo.mp3",
                name: Some("01 1234 foo.mp3"),
                is_dir: false,
                size: 1234567,
                modified: "2000-01-01T00:00:00Z",
                perms: Some("r--r--r--"),
                writable: Some(false),
            },
            // Symlink: the "-> target" suffix is stripped from the name and the
            // entry is not a directory.
            Case {
                line: b"lrwxrwxrwx 1 0 0 7 Nov 5 2018 link -> target",
                name: Some("link"),
                is_dir: false,
                size: 7,
                modified: "2018-11-05T00:00:00Z",
                perms: Some("rwxrwxrwx"),
                writable: Some(true),
            },
            // "total" summary line and junk are skipped.
            Case {
                line: b"total 8",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
            Case {
                line: b"this is not a listing line",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
        ];
        for case in &cases {
            check(parse_list_line(case.line, DIR), case);
        }
    }

    #[test]
    fn parses_windows_dos_lines() {
        let cases = [
            // Directory (<DIR> marker, size 0).
            Case {
                line: b"04-08-14  03:09PM  <DIR> docs",
                name: Some("docs"),
                is_dir: true,
                size: 0,
                modified: "2014-04-08T15:09:00Z",
                perms: None,
                writable: None,
            },
            // Regular file with a size.
            Case {
                line: b"04-08-14  03:09PM  8192 omar.txt",
                name: Some("omar.txt"),
                is_dir: false,
                size: 8192,
                modified: "2014-04-08T15:09:00Z",
                perms: None,
                writable: None,
            },
            // Malformed date → skipped.
            Case {
                line: b"-08-14  03:09PM  <DIR> docs",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
        ];
        for case in &cases {
            check(parse_list_line(case.line, DIR), case);
        }
    }

    #[test]
    fn parses_mlsd_lines() {
        let cases = [
            // File with default (777) permissions.
            Case {
                line: b"type=file;size=8192;modify=20181105163248; omar.txt",
                name: Some("omar.txt"),
                is_dir: false,
                size: 8192,
                modified: "2018-11-05T16:32:48Z",
                perms: Some("rwxrwxrwx"),
                writable: Some(true),
            },
            // Directory.
            Case {
                line: b"type=dir;size=4096;modify=20181105163248; docs",
                name: Some("docs"),
                is_dir: true,
                size: 4096,
                modified: "2018-11-05T16:32:48Z",
                perms: Some("rwxrwxrwx"),
                writable: Some(true),
            },
            // File carrying an explicit unix.mode fact.
            Case {
                line: b"type=file;size=4096;modify=20181105163248;unix.mode=644; data.bin",
                name: Some("data.bin"),
                is_dir: false,
                size: 4096,
                modified: "2018-11-05T16:32:48Z",
                perms: Some("rw-r--r--"),
                writable: Some(true),
            },
            // Read-only file (unix.mode=444) → no class may write.
            Case {
                line: b"type=file;size=4096;modify=20181105163248;unix.mode=444; readonly.bin",
                name: Some("readonly.bin"),
                is_dir: false,
                size: 4096,
                modified: "2018-11-05T16:32:48Z",
                perms: Some("r--r--r--"),
                writable: Some(false),
            },
            // Symlink (type=link) → not a directory.
            Case {
                line: b"type=link;modify=20181105163248; shortcut",
                name: Some("shortcut"),
                is_dir: false,
                size: 0,
                modified: "2018-11-05T16:32:48Z",
                perms: Some("rwxrwxrwx"),
                writable: Some(true),
            },
            // Unknown type → malformed, skipped.
            Case {
                line: b"type=bogus;size=1;modify=20181105163248; junk",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
            // Empty line → skipped.
            Case {
                line: b"",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
        ];
        for case in &cases {
            check(parse_mlsd_line(case.line, DIR), case);
        }
    }

    /// Real ProFTPD MLSD output: rich fact set with a four-digit `UNIX.mode`,
    /// `perm=`, `unique=`, `UNIX.*` facts, and `type=cdir` / `type=pdir` self /
    /// parent markers. suppaftp's own MLSx parser rejects these, which is why
    /// the file browser parses MLSD directly. Regression for issue #1456.
    #[test]
    fn parses_proftpd_mlsd_lines() {
        let cases = [
            // Self entry (cdir) → skipped like `.`.
            Case {
                line: b"modify=20260712220726;perm=fle;type=cdir;unique=43U1000329;UNIX.group=0;UNIX.groupname=ftpuser;UNIX.mode=0755;UNIX.owner=0;UNIX.ownername=ftpuser; .",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
            // Parent entry (pdir) → skipped like `..`.
            Case {
                line: b"modify=20260712220726;perm=fle;type=pdir;unique=43UCEF2BD;UNIX.group=65534;UNIX.groupname=ftpuser;UNIX.mode=0755;UNIX.owner=101;UNIX.ownername=ftpuser; ..",
                name: None,
                is_dir: false,
                size: 0,
                modified: "",
                perms: None,
                writable: None,
            },
            // Directory with a four-digit UNIX.mode.
            Case {
                line: b"modify=20260712220726;perm=fle;type=dir;unique=43U1459CB7;UNIX.group=0;UNIX.groupname=ftpuser;UNIX.mode=0755;UNIX.owner=0;UNIX.ownername=ftpuser; data",
                name: Some("data"),
                is_dir: true,
                size: 0,
                modified: "2026-07-12T22:07:26Z",
                perms: Some("rwxr-xr-x"),
                writable: Some(true),
            },
            // Regular file with size + four-digit UNIX.mode.
            Case {
                line: b"modify=20260712220726;perm=adfr;size=61;type=file;unique=43U100032A;UNIX.group=0;UNIX.groupname=ftpuser;UNIX.mode=0644;UNIX.owner=0;UNIX.ownername=ftpuser; readme.txt",
                name: Some("readme.txt"),
                is_dir: false,
                size: 61,
                modified: "2026-07-12T22:07:26Z",
                perms: Some("rw-r--r--"),
                writable: Some(true),
            },
            // MLST (single-entry) echoes the full pathname as the name; it must
            // be reduced to the base name (DIR here is the entry's parent).
            Case {
                line: b"type=file;size=61;modify=20260712220726;UNIX.mode=0644; /pub/readme.txt",
                name: Some("readme.txt"),
                is_dir: false,
                size: 61,
                modified: "2026-07-12T22:07:26Z",
                perms: Some("rw-r--r--"),
                writable: Some(true),
            },
        ];
        for case in &cases {
            check(parse_mlsd_line(case.line, DIR), case);
        }
    }

    #[test]
    fn parses_symlink_target_from_posix_line() {
        // A Unix `ls -l` symlink: `-> target` is stripped from the name, the
        // entry is flagged as a symlink, and the absolute target is captured.
        let entry = parse_list_line(b"lrwxrwxrwx 1 0 0 7 Nov 5 2018 link -> /etc/target", DIR)
            .expect("symlink line should parse");
        assert_eq!(entry.name, "link");
        assert!(entry.is_symlink, "is_symlink");
        assert_eq!(entry.symlink_target.as_deref(), Some("/etc/target"));
        assert!(!entry.is_directory);
    }

    #[test]
    fn parses_symlink_flag_from_mlsd_line() {
        // MLSD `type=link` marks a symlink but carries no target fact.
        let entry = parse_mlsd_line(b"type=link;modify=20181105163248; shortcut", DIR)
            .expect("mlsd link should parse");
        assert!(entry.is_symlink, "is_symlink");
        assert_eq!(entry.symlink_target, None);
        assert!(!entry.is_directory);
    }

    #[test]
    fn non_symlink_entries_carry_no_symlink_metadata() {
        let file = parse_list_line(b"-rw-r--r-- 1 0 0 12 Mar 18 2018 a.txt", DIR).unwrap();
        assert!(!file.is_symlink);
        assert_eq!(file.symlink_target, None);

        let dir = parse_mlsd_line(b"type=dir;size=4096;modify=20181105163248; docs", DIR).unwrap();
        assert!(!dir.is_symlink);
        assert_eq!(dir.symlink_target, None);
    }

    #[test]
    fn skips_dot_entries() {
        // MLSD "." / ".." entries are dropped.
        assert!(parse_mlsd_line(b"type=cdir;modify=20181105163248; .", DIR).is_none());
        assert!(parse_mlsd_line(b"type=pdir;modify=20181105163248; ..", DIR).is_none());
    }

    #[test]
    fn decodes_latin1_names() {
        // A Unix line whose name ends in a Latin-1 'é' (0xE9), which is not
        // valid UTF-8. The name must round-trip through the Latin-1 fallback.
        let mut line = b"-rw-r--r-- 1 0 0 5 Nov 5 2018 caf".to_vec();
        line.push(0xE9);
        let entry = parse_list_line(&line, DIR).expect("latin-1 name should parse");
        assert_eq!(entry.name, "caf\u{00E9}");
        assert!(!entry.is_directory);
        assert_eq!(entry.size, 5);
    }

    #[test]
    fn decode_bytes_prefers_utf8() {
        assert_eq!(decode_bytes("näme".as_bytes()), "näme");
        // Lone 0xFF is invalid UTF-8 → Latin-1 ÿ (U+00FF).
        assert_eq!(decode_bytes(&[b'x', 0xFF]), "x\u{00FF}");
    }

    #[test]
    fn parses_full_listings_skipping_bad_lines() {
        let list = vec![
            "total 3".to_string(),
            "drwxrwxr-x 1 root dialout 4096 Nov 5 2018 docs".to_string(),
            "garbage".to_string(),
            "-rw-r--r-- 1 0 0 12 Mar 18 2018 a.txt".to_string(),
        ];
        let entries = parse_list(&list, DIR);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["docs", "a.txt"]);

        let mlsd = vec![
            "type=dir;modify=20181105163248; sub".to_string(),
            "type=bogus; junk".to_string(),
            "type=file;size=1;modify=20181105163248; b.bin".to_string(),
        ];
        let names: Vec<String> = parse_mlsd(&mlsd, DIR).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["sub".to_string(), "b.bin".to_string()]);
    }
}
