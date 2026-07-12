/// Format a Unix timestamp (seconds since epoch) as ISO 8601.
pub fn chrono_from_epoch(secs: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let dt = UNIX_EPOCH + Duration::from_secs(secs);
    match dt.duration_since(UNIX_EPOCH) {
        Ok(d) => {
            let total_secs = d.as_secs();
            let days = total_secs / 86400;
            let remaining = total_secs % 86400;
            let hours = remaining / 3600;
            let minutes = (remaining % 3600) / 60;
            let seconds = remaining % 60;

            let (year, month, day) = days_to_ymd(days);
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                year, month, day, hours, minutes, seconds
            )
        }
        Err(_) => String::new(),
    }
}

/// Convert days since Unix epoch to (year, month, day).
fn days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Format Unix permission bits as `rwxrwxrwx` string.
pub fn format_permissions(perm: u32) -> String {
    let mut s = String::with_capacity(9);
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in bits {
        if perm & bit != 0 {
            s.push(ch);
        } else {
            s.push('-');
        }
    }
    s
}

/// Derive writability from a 9-char Unix mode string (`rwxrwxrwx`).
///
/// This is the **cheap, conservative** layer of read-only detection: a file is
/// considered writable if *any* class (owner/group/other) carries a write bit,
/// because `russh-sftp` exposes no uid/gid to know which class applies to the
/// connecting user. It therefore only catches the case where *nobody* may write
/// (e.g. `r--r--r--`); the owner-mismatch case (a `rw-r--r--` file owned by
/// another user) is caught by the authoritative write-open probe instead.
///
/// Expects the 9-char form produced by [`format_permissions`] (no leading type
/// char). Returns:
/// - `Some(true)`  — a write bit is set in at least one class,
/// - `Some(false)` — all three write positions are present but unset,
/// - `None`        — the string is empty/absent or too short to interpret.
pub fn writable_from_permissions(perms: &str) -> Option<bool> {
    let bytes = perms.as_bytes();
    // Owner/group/other write bits sit at indices 1, 4, 7 of `rwxrwxrwx`.
    if bytes.len() < 9 {
        return None;
    }
    Some(bytes[1] == b'w' || bytes[4] == b'w' || bytes[7] == b'w')
}

/// Normalize path separators to forward slashes for cross-platform consistency.
///
/// On Windows, backslashes are replaced with forward slashes so the frontend
/// can use a single `split("/")` code path for path manipulation.
pub fn normalize_path_separators(path: &str) -> String {
    path.replace('\\', "/")
}

/// Convert MSYS-style Unix paths (e.g. `/c/Users/...`) to Windows paths (`C:/Users/...`).
///
/// Git Bash on Windows sets `$HOME` to paths like `/c/Users/username`.
/// Windows APIs cannot resolve these, so we detect the pattern (a single
/// ASCII letter after the leading `/`) and rewrite it to a drive letter.
#[cfg(windows)]
fn convert_msys_path(path: &str) -> String {
    let bytes = path.as_bytes();
    // Match `/x` or `/x/...` where x is a single ASCII letter
    if bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b'/')
    {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        format!("{}:/{}", drive, &path[2..].trim_start_matches('/'))
    } else {
        path.to_string()
    }
}

/// Normalize a filesystem path for the current platform.
///
/// On Windows this converts MSYS-style Unix paths (`/c/Users/...`) to Windows
/// drive paths (`C:/Users/...`) and replaces backslashes with forward slashes.
/// On other platforms this is equivalent to [`normalize_path_separators`].
pub fn normalize_platform_path(path: &str) -> String {
    #[cfg(windows)]
    {
        let converted = convert_msys_path(path);
        normalize_path_separators(&converted)
    }
    #[cfg(not(windows))]
    {
        normalize_path_separators(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrono_from_epoch_zero() {
        assert_eq!(chrono_from_epoch(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn chrono_from_epoch_known_timestamp() {
        // 2024-01-15 12:30:45 UTC = 1705321845
        assert_eq!(chrono_from_epoch(1705321845), "2024-01-15T12:30:45Z");
    }

    #[test]
    fn format_permissions_755() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
    }

    #[test]
    fn format_permissions_644() {
        assert_eq!(format_permissions(0o644), "rw-r--r--");
    }

    #[test]
    fn format_permissions_000() {
        assert_eq!(format_permissions(0o000), "---------");
    }

    #[test]
    fn format_permissions_777() {
        assert_eq!(format_permissions(0o777), "rwxrwxrwx");
    }

    #[test]
    fn writable_from_permissions_read_only() {
        // `-r--r--r--` collapses to the 9-char form `r--r--r--`: no write bit.
        assert_eq!(writable_from_permissions("r--r--r--"), Some(false));
    }

    #[test]
    fn writable_from_permissions_all_writable() {
        assert_eq!(writable_from_permissions("rw-rw-rw-"), Some(true));
    }

    #[test]
    fn writable_from_permissions_owner_only_writable() {
        // Owner has write, group/other do not — writable via ANY class.
        assert_eq!(writable_from_permissions("rw-r--r--"), Some(true));
    }

    #[test]
    fn writable_from_permissions_owner_rwx() {
        assert_eq!(writable_from_permissions("rwx------"), Some(true));
    }

    #[test]
    fn writable_from_permissions_read_execute_only() {
        assert_eq!(writable_from_permissions("r-xr-xr-x"), Some(false));
    }

    #[test]
    fn writable_from_permissions_empty_is_none() {
        assert_eq!(writable_from_permissions(""), None);
    }

    #[test]
    fn writable_from_permissions_group_only_writable() {
        assert_eq!(writable_from_permissions("r--rw-r--"), Some(true));
    }

    #[test]
    fn normalize_path_separators_converts_backslashes() {
        assert_eq!(
            normalize_path_separators(r"C:\Users\foo\bar"),
            "C:/Users/foo/bar"
        );
    }

    #[test]
    fn normalize_path_separators_preserves_forward_slashes() {
        assert_eq!(
            normalize_path_separators("/unix/path/here"),
            "/unix/path/here"
        );
    }

    #[test]
    fn normalize_path_separators_handles_mixed() {
        assert_eq!(
            normalize_path_separators(r"C:\Users/foo\bar"),
            "C:/Users/foo/bar"
        );
    }

    #[test]
    fn normalize_path_separators_handles_unc_paths() {
        assert_eq!(
            normalize_path_separators(r"\\wsl$\Ubuntu\home"),
            "//wsl$/Ubuntu/home"
        );
    }

    #[test]
    fn normalize_path_separators_empty_string() {
        assert_eq!(normalize_path_separators(""), "");
    }

    // ── normalize_platform_path tests ──────────────────────────────────

    #[cfg(windows)]
    mod platform_path_windows {
        use super::super::*;

        #[test]
        fn converts_msys_drive_path() {
            assert_eq!(normalize_platform_path("/c/Users/foo"), "C:/Users/foo");
        }

        #[test]
        fn converts_msys_uppercase_drive() {
            assert_eq!(normalize_platform_path("/D/projects"), "D:/projects");
        }

        #[test]
        fn converts_bare_drive_letter() {
            assert_eq!(normalize_platform_path("/c"), "C:/");
        }

        #[test]
        fn does_not_convert_non_drive_unix_path() {
            // /usr is not a single-letter drive, leave as-is
            assert_eq!(normalize_platform_path("/usr/bin"), "/usr/bin");
        }

        #[test]
        fn passes_through_normal_windows_path() {
            assert_eq!(
                normalize_platform_path(r"C:\Users\foo\bar"),
                "C:/Users/foo/bar"
            );
        }

        #[test]
        fn handles_empty_string() {
            assert_eq!(normalize_platform_path(""), "");
        }

        #[test]
        fn converts_backslashes_in_msys_path() {
            // Unlikely but handles mixed separators
            assert_eq!(
                normalize_platform_path("/c/Users\\foo\\bar"),
                "C:/Users/foo/bar"
            );
        }
    }

    #[cfg(not(windows))]
    mod platform_path_unix {
        use super::super::*;

        #[test]
        fn preserves_unix_paths() {
            assert_eq!(normalize_platform_path("/home/user"), "/home/user");
        }

        #[test]
        fn preserves_single_letter_unix_paths() {
            // On Unix, /c/Users is a valid path — don't transform it
            assert_eq!(normalize_platform_path("/c/Users/foo"), "/c/Users/foo");
        }

        #[test]
        fn handles_empty_string() {
            assert_eq!(normalize_platform_path(""), "");
        }
    }
}
