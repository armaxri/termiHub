//! X11 server detection and DISPLAY parsing utilities.

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

/// Detect the local X server from the DISPLAY environment variable.
pub fn detect_local_x_server() -> Option<LocalXServerInfo> {
    let display = std::env::var("DISPLAY").ok()?;
    if display.is_empty() {
        return None;
    }

    let (host, display_number, _screen) = parse_display(&display)?;

    match host {
        None => {
            // Local display `:N` — try Unix socket first, fall back to TCP
            let socket_path = format!("/tmp/.X11-unix/X{}", display_number);
            if std::path::Path::new(&socket_path).exists() {
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(socket_path),
                })
            } else {
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp("localhost".to_string(), 6000 + display_number as u16),
                })
            }
        }
        Some(ref h) if h.starts_with('/') => {
            // macOS XQuartz: /private/tmp/com.apple.launchd.xxx/org.xquartz:0
            // The host_part is the Unix socket path
            if std::path::Path::new(h).exists() || std::path::Path::new(&format!("{}:{}", h, display_number)).exists() {
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(h.clone()),
                })
            } else {
                // Fall back to TCP even for XQuartz
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp("localhost".to_string(), 6000 + display_number as u16),
                })
            }
        }
        Some(ref h) if h == "localhost" || h == "127.0.0.1" || h == "::1" => {
            // Explicit localhost — try Unix socket first, fall back to TCP
            let socket_path = format!("/tmp/.X11-unix/X{}", display_number);
            if std::path::Path::new(&socket_path).exists() {
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::UnixSocket(socket_path),
                })
            } else {
                Some(LocalXServerInfo {
                    display_number,
                    connection: LocalXConnection::Tcp(h.clone(), 6000 + display_number as u16),
                })
            }
        }
        Some(h) => {
            // Remote host — TCP only
            Some(LocalXServerInfo {
                display_number,
                connection: LocalXConnection::Tcp(h, 6000 + display_number as u16),
            })
        }
    }
}

/// Check if a local X server is likely running and reachable.
pub fn is_x_server_likely_running() -> bool {
    detect_local_x_server().is_some()
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
