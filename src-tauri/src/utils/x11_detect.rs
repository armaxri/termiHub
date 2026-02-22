//! Legacy X11 server detection and DISPLAY parsing utilities.
//!
//! The canonical implementation is now in
//! [`termihub_core::backends::ssh::x11`](termihub_core::backends::ssh).
//! This module will be removed once all callers are migrated to use
//! the core SSH backend.

/// Describes how to connect to the local X server.
#[derive(Debug, Clone)]
pub enum LocalXConnection {
    UnixSocket(String),
    Tcp(String, u16),
}

/// Local X server info needed for forwarding.
#[derive(Debug, Clone)]
pub struct LocalXServerInfo {
    pub display_number: u32,
    pub connection: LocalXConnection,
}

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

/// Build a `LocalXServerInfo` from a parsed DISPLAY value.
fn info_from_parsed(host: Option<String>, display_number: u32) -> LocalXServerInfo {
    match host {
        None => {
            // Local display `:N` — try Unix socket first, fall back to TCP
            let socket_path = format!("/tmp/.X11-unix/X{}", display_number);
            if std::path::Path::new(&socket_path).exists() {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(socket_path),
                }
            } else {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(
                        "localhost".to_string(),
                        6000 + display_number as u16,
                    ),
                }
            }
        }
        Some(ref h) if h.starts_with('/') => {
            // macOS XQuartz: /private/tmp/com.apple.launchd.xxx/org.xquartz:0
            if std::path::Path::new(h).exists()
                || std::path::Path::new(&format!("{}:{}", h, display_number)).exists()
            {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(h.clone()),
                }
            } else {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(
                        "localhost".to_string(),
                        6000 + display_number as u16,
                    ),
                }
            }
        }
        Some(ref h) if h == "localhost" || h == "127.0.0.1" || h == "::1" => {
            let socket_path = format!("/tmp/.X11-unix/X{}", display_number);
            if std::path::Path::new(&socket_path).exists() {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(socket_path),
                }
            } else {
                LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(h.clone(), 6000 + display_number as u16),
                }
            }
        }
        Some(h) => {
            // Remote host — TCP only
            LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(h, 6000 + display_number as u16),
            }
        }
    }
}

/// Detect the local X server.
///
/// Checks the DISPLAY environment variable first, then falls back to
/// scanning `/tmp/.X11-unix/` for live sockets (covers macOS XQuartz
/// when DISPLAY is not propagated to the process environment).
pub fn detect_local_x_server() -> Option<LocalXServerInfo> {
    // Try DISPLAY env var first
    if let Ok(display) = std::env::var("DISPLAY") {
        if !display.is_empty() {
            let (host, display_number, _screen) = parse_display(&display)?;
            return Some(info_from_parsed(host, display_number));
        }
    }

    // DISPLAY not set — scan for X11 sockets directly
    detect_from_sockets()
}

/// Scan `/tmp/.X11-unix/` for X server sockets.
fn detect_from_sockets() -> Option<LocalXServerInfo> {
    let x11_dir = std::path::Path::new("/tmp/.X11-unix");
    if !x11_dir.is_dir() {
        return None;
    }

    let entries = std::fs::read_dir(x11_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(num_str) = name.strip_prefix('X') {
            if let Ok(display_num) = num_str.parse::<u32>() {
                let socket_path = format!("/tmp/.X11-unix/X{}", display_num);
                return Some(LocalXServerInfo {
                    display_number: display_num,
                    connection: LocalXConnection::UnixSocket(socket_path),
                });
            }
        }
    }
    None
}

/// Check if a local X server is likely running and reachable.
pub fn is_x_server_likely_running() -> bool {
    detect_local_x_server().is_some()
}

/// Read the MIT-MAGIC-COOKIE-1 for the given local display number.
///
/// Runs `xauth list :N` and parses the hex cookie from the output.
/// Returns `None` if xauth is not installed or no cookie is found.
pub fn read_local_xauth_cookie(display_number: u32) -> Option<String> {
    let output = std::process::Command::new("xauth")
        .args(["list", &format!(":{}", display_number)])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Format: "hostname/unix:N  MIT-MAGIC-COOKIE-1  hexcookie"
    for line in stdout.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[1] == "MIT-MAGIC-COOKIE-1" {
            return Some(parts[2].to_string());
        }
    }
    None
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
