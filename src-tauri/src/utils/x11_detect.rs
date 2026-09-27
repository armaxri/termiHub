//! Local X11 server availability check for the `check_x11_available` command.
//!
//! The full detection (socket/TCP resolution used by the SSH X11 forwarder) lives
//! in [`termihub_core::backends::ssh::x11`](termihub_core::backends::ssh). This
//! module keeps only the yes/no answer the UI needs, with its original semantics:
//! a non-empty `DISPLAY` counts when it parses, otherwise a `/tmp/.X11-unix/X<N>`
//! socket entry does.

/// Parse a DISPLAY string into (host, display_number, screen_number).
///
/// Handles formats:
/// - `:N` or `:N.S` — local display
/// - `host:N` or `host:N.S` — remote display
/// - `/path/to/socket:N` (macOS XQuartz) — Unix socket with display number
fn parse_display(display: &str) -> Option<(Option<String>, u32, u32)> {
    // Find the last colon that separates the host/path from display.screen
    let colon_pos = display.rfind(':')?;
    let host_part = &display[..colon_pos];
    let display_screen = &display[colon_pos + 1..];

    // Parse display.screen
    let (display_num, screen_num) = if let Some(dot_pos) = display_screen.find('.') {
        let d: u32 = display_screen[..dot_pos].parse().ok()?;
        let s: u32 = display_screen[dot_pos + 1..].parse().ok()?;
        (d, s)
    } else {
        let d: u32 = display_screen.parse().ok()?;
        (d, 0)
    };

    let host = if host_part.is_empty() {
        None
    } else {
        Some(host_part.to_string())
    };

    Some((host, display_num, screen_num))
}

/// Whether `/tmp/.X11-unix/` holds an X server socket entry (`X<N>`).
fn has_x11_socket() -> bool {
    let Ok(entries) = std::fs::read_dir("/tmp/.X11-unix") else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .strip_prefix('X')
            .is_some_and(|num| num.parse::<u32>().is_ok())
    })
}

/// Check if a local X server is likely running and reachable.
///
/// Honors `DISPLAY` first: when set and non-empty, the answer is whether it
/// parses. Otherwise scans `/tmp/.X11-unix/` for a live socket entry (covers
/// macOS XQuartz when `DISPLAY` is not propagated to the process environment).
pub fn is_x_server_likely_running() -> bool {
    if let Ok(display) = std::env::var("DISPLAY") {
        if !display.is_empty() {
            return parse_display(&display).is_some();
        }
    }
    has_x11_socket()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_display_local() {
        let (host, display, screen) = parse_display(":0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_local_with_screen() {
        let (host, display, screen) = parse_display(":0.0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_local_high_number() {
        let (host, display, screen) = parse_display(":10.0").unwrap();
        assert!(host.is_none());
        assert_eq!(display, 10);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_localhost() {
        let (host, display, screen) = parse_display("localhost:10.0").unwrap();
        assert_eq!(host.as_deref(), Some("localhost"));
        assert_eq!(display, 10);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_remote_host() {
        let (host, display, screen) = parse_display("myhost:5.0").unwrap();
        assert_eq!(host.as_deref(), Some("myhost"));
        assert_eq!(display, 5);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_xquartz() {
        let (host, display, screen) =
            parse_display("/private/tmp/com.apple.launchd.abc/org.xquartz:0").unwrap();
        assert_eq!(
            host.as_deref(),
            Some("/private/tmp/com.apple.launchd.abc/org.xquartz")
        );
        assert_eq!(display, 0);
        assert_eq!(screen, 0);
    }

    #[test]
    fn test_parse_display_empty() {
        assert!(parse_display("").is_none());
    }

    #[test]
    fn test_parse_display_no_colon() {
        assert!(parse_display("nodisplay").is_none());
    }

    #[test]
    fn test_parse_display_invalid_number() {
        assert!(parse_display(":abc").is_none());
    }
}
