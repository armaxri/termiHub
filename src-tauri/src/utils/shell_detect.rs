use std::path::Path;

/// Well-known Git Bash installation paths on Windows.
#[cfg(windows)]
const GIT_BASH_PATHS: &[&str] = &[
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
];

/// Parse the raw stdout from `wsl.exe --list --quiet`.
///
/// `wsl.exe` emits UTF-16LE text (often with a BOM). This function decodes
/// the bytes, strips the BOM and null characters, and returns a list of
/// distro names with empty lines removed.
#[cfg(any(windows, test))]
pub fn parse_wsl_output(raw: &[u8]) -> Vec<String> {
    // Decode UTF-16LE: take pairs of bytes, form u16 code units
    let code_units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();

    let text = String::from_utf16_lossy(&code_units);

    text.lines()
        .map(|line| line.trim().replace('\0', ""))
        // Strip BOM character (U+FEFF)
        .map(|line| line.trim_start_matches('\u{FEFF}').to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Detect installed WSL distributions by running `wsl.exe --list --quiet`.
///
/// Returns an empty list if the command fails or WSL is not installed.
#[cfg(windows)]
pub fn detect_wsl_distros() -> Vec<String> {
    let output = std::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .output();

    match output {
        Ok(out) if out.status.success() => parse_wsl_output(&out.stdout),
        _ => Vec::new(),
    }
}

/// Detect available shells on the current platform.
pub fn detect_available_shells() -> Vec<String> {
    let mut shells = Vec::new();

    #[cfg(unix)]
    {
        let candidates = [
            ("/bin/zsh", "zsh"),
            ("/usr/bin/zsh", "zsh"),
            ("/bin/bash", "bash"),
            ("/usr/bin/bash", "bash"),
            ("/bin/sh", "sh"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (path, name) in &candidates {
            if Path::new(path).exists() && seen.insert(*name) {
                shells.push(name.to_string());
            }
        }
    }

    #[cfg(windows)]
    {
        shells.push("powershell".to_string());
        shells.push("cmd".to_string());

        // Check for Git Bash
        for path in GIT_BASH_PATHS {
            if Path::new(path).exists() {
                shells.push("gitbash".to_string());
                break;
            }
        }

        // Detect WSL distributions
        for distro in detect_wsl_distros() {
            shells.push(format!("wsl:{distro}"));
        }
    }

    shells
}

/// Detect the user's default shell on this platform.
///
/// On Unix, reads the `$SHELL` environment variable and extracts the
/// shell name (e.g., `/bin/zsh` → `"zsh"`).
/// On Windows, returns `"powershell"` as the modern default.
pub fn detect_default_shell() -> Option<String> {
    #[cfg(unix)]
    {
        if let Ok(shell_path) = std::env::var("SHELL") {
            if let Some(name) = Path::new(&shell_path).file_name() {
                return Some(name.to_string_lossy().to_string());
            }
        }
        return None;
    }

    #[cfg(windows)]
    {
        return Some("powershell".to_string());
    }

    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_wsl_output_utf16le_distros() {
        // Simulate UTF-16LE output: "Ubuntu\r\nDebian\r\n"
        let text = "Ubuntu\r\nDebian\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();

        let result = parse_wsl_output(&raw);
        assert_eq!(result, vec!["Ubuntu", "Debian"]);
    }

    #[test]
    fn parse_wsl_output_with_bom() {
        // UTF-16LE BOM (FF FE) followed by "Ubuntu\r\n"
        let text = "\u{FEFF}Ubuntu\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();

        let result = parse_wsl_output(&raw);
        assert_eq!(result, vec!["Ubuntu"]);
    }

    #[test]
    fn parse_wsl_output_empty_input() {
        let result = parse_wsl_output(&[]);
        assert!(result.is_empty());
    }

    #[test]
    fn parse_wsl_output_odd_byte_count() {
        // Odd number of bytes — the trailing byte is ignored by chunks_exact
        let raw = vec![0x55, 0x00, 0x0D]; // 'U' in UTF-16LE + stray byte
        let result = parse_wsl_output(&raw);
        assert_eq!(result, vec!["U"]);
    }

    #[test]
    fn parse_wsl_output_with_null_bytes_in_text() {
        // Some WSL versions emit trailing null characters
        let text = "Ubuntu\0\r\n";
        let raw: Vec<u8> = text.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();

        let result = parse_wsl_output(&raw);
        assert_eq!(result, vec!["Ubuntu"]);
    }

    #[test]
    fn detect_default_shell_returns_some() {
        // On any CI or dev machine, there should be a default shell
        let result = detect_default_shell();
        assert!(result.is_some(), "expected a default shell to be detected");
        let name = result.unwrap();
        assert!(!name.is_empty());
        // Should be a bare name, not a path
        assert!(!name.contains('/'), "expected bare name, got: {name}");
    }

    #[cfg(unix)]
    #[test]
    fn detect_default_shell_reads_shell_env() {
        // Temporarily set SHELL to a known value
        let orig = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", "/usr/bin/fish");

        let result = detect_default_shell();
        assert_eq!(result, Some("fish".to_string()));

        // Restore
        if let Some(val) = orig {
            std::env::set_var("SHELL", val);
        } else {
            std::env::remove_var("SHELL");
        }
    }
}
