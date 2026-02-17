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
/// Returns an empty list on non-Windows platforms or if the command fails.
pub fn detect_wsl_distros() -> Vec<String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet"])
            .output();

        match output {
            Ok(out) if out.status.success() => parse_wsl_output(&out.stdout),
            _ => Vec::new(),
        }
    }

    #[cfg(not(windows))]
    {
        Vec::new()
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

/// Resolve a shell name to the executable path and arguments.
///
/// On Windows, returns full paths for PowerShell and Git Bash to avoid
/// misrouting through WSL (which intercepts bare `bash.exe` and can
/// interfere with `powershell.exe` lookups).
pub fn shell_to_command(shell: &str) -> (String, Vec<String>) {
    // Handle WSL distros (e.g., "wsl:Ubuntu", "wsl:Debian")
    if let Some(distro) = shell.strip_prefix("wsl:") {
        return resolve_wsl(distro);
    }

    match shell {
        "zsh" => ("zsh".into(), vec!["--login".into()]),
        "bash" => resolve_bash(),
        "sh" => ("sh".into(), vec![]),
        "cmd" => ("cmd.exe".into(), vec![]),
        "powershell" => resolve_powershell(),
        "gitbash" => resolve_git_bash(),
        _ => ("sh".into(), vec![]),
    }
}

/// Resolve the path and arguments to launch a WSL distribution.
///
/// On Windows, uses the absolute path under `SYSTEMROOT` for reliability.
/// Falls back to bare `wsl.exe` if `SYSTEMROOT` is not set.
fn resolve_wsl(distro: &str) -> (String, Vec<String>) {
    let wsl_path = {
        #[cfg(windows)]
        {
            if let Ok(system_root) = std::env::var("SYSTEMROOT") {
                let full = format!(r"{}\System32\wsl.exe", system_root);
                if Path::new(&full).exists() {
                    full
                } else {
                    "wsl.exe".to_string()
                }
            } else {
                "wsl.exe".to_string()
            }
        }
        #[cfg(not(windows))]
        {
            "wsl.exe".to_string()
        }
    };

    (wsl_path, vec!["-d".into(), distro.to_string()])
}

/// Resolve bash.
///
/// On Windows, bare `bash` is intercepted by WSL, so we resolve to
/// Git Bash instead. On Unix, uses the plain `bash` name.
fn resolve_bash() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // On Windows, bare "bash" maps to WSL — use Git Bash instead
        return resolve_git_bash();
    }
    #[allow(unreachable_code)]
    ("bash".into(), vec!["--login".into()])
}

/// Resolve the full path to PowerShell on Windows.
///
/// Falls back to the bare name on non-Windows platforms.
fn resolve_powershell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // Prefer PowerShell under SYSTEMROOT for a reliable absolute path
        if let Ok(system_root) = std::env::var("SYSTEMROOT") {
            let full = format!(
                r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
                system_root
            );
            if Path::new(&full).exists() {
                return (full, vec!["-NoLogo".into()]);
            }
        }
    }
    ("powershell.exe".into(), vec!["-NoLogo".into()])
}

/// Resolve the full path to Git Bash on Windows.
///
/// Falls back to the bare name on non-Windows platforms.
fn resolve_git_bash() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        for path in GIT_BASH_PATHS {
            if Path::new(path).exists() {
                return ((*path).to_string(), vec!["--login".into()]);
            }
        }
    }
    ("bash.exe".into(), vec!["--login".into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_to_command_zsh() {
        let (cmd, args) = shell_to_command("zsh");
        assert_eq!(cmd, "zsh");
        assert_eq!(args, vec!["--login"]);
    }

    #[test]
    fn shell_to_command_bash() {
        let (cmd, args) = shell_to_command("bash");
        assert_eq!(args, vec!["--login"]);
        // On Windows, "bash" resolves to Git Bash to avoid WSL interception
        #[cfg(windows)]
        {
            if Path::new(r"C:\Program Files\Git\bin\bash.exe").exists()
                || Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe").exists()
            {
                assert!(
                    cmd.ends_with(r"\bash.exe") && cmd.contains("Git"),
                    "expected Git Bash absolute path, got: {cmd}"
                );
            }
        }
        #[cfg(not(windows))]
        assert_eq!(cmd, "bash");
    }

    #[test]
    fn shell_to_command_sh() {
        let (cmd, args) = shell_to_command("sh");
        assert_eq!(cmd, "sh");
        assert!(args.is_empty());
    }

    #[test]
    fn shell_to_command_cmd() {
        let (cmd, args) = shell_to_command("cmd");
        assert_eq!(cmd, "cmd.exe");
        assert!(args.is_empty());
    }

    #[test]
    fn shell_to_command_powershell() {
        let (cmd, args) = shell_to_command("powershell");
        assert_eq!(args, vec!["-NoLogo"]);
        // On Windows the path must be absolute to avoid WSL interception
        #[cfg(windows)]
        assert!(
            cmd.ends_with(r"\powershell.exe"),
            "expected absolute path, got: {cmd}"
        );
        #[cfg(not(windows))]
        assert_eq!(cmd, "powershell.exe");
    }

    #[test]
    fn shell_to_command_gitbash() {
        let (cmd, args) = shell_to_command("gitbash");
        assert_eq!(args, vec!["--login"]);
        // On Windows the path must be absolute to avoid WSL interception
        #[cfg(windows)]
        {
            if Path::new(r"C:\Program Files\Git\bin\bash.exe").exists()
                || Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe").exists()
            {
                assert!(
                    cmd.ends_with(r"\bash.exe") && cmd.contains("Git"),
                    "expected Git Bash absolute path, got: {cmd}"
                );
            }
        }
        #[cfg(not(windows))]
        assert_eq!(cmd, "bash.exe");
    }

    #[test]
    fn shell_to_command_unknown_falls_back_to_sh() {
        let (cmd, args) = shell_to_command("fish");
        assert_eq!(cmd, "sh");
        assert!(args.is_empty());
    }

    #[test]
    fn shell_to_command_wsl_ubuntu() {
        let (cmd, args) = shell_to_command("wsl:Ubuntu");
        assert!(cmd.ends_with("wsl.exe"), "expected wsl.exe, got: {cmd}");
        assert_eq!(args, vec!["-d", "Ubuntu"]);
    }

    #[test]
    fn shell_to_command_wsl_with_version_suffix() {
        let (cmd, args) = shell_to_command("wsl:Ubuntu-22.04");
        assert!(cmd.ends_with("wsl.exe"), "expected wsl.exe, got: {cmd}");
        assert_eq!(args, vec!["-d", "Ubuntu-22.04"]);
    }

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

    #[cfg(windows)]
    #[test]
    fn powershell_path_is_absolute() {
        let (cmd, _) = resolve_powershell();
        assert!(
            Path::new(&cmd).is_absolute(),
            "PowerShell path should be absolute on Windows, got: {cmd}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn wsl_command_uses_absolute_path() {
        let (cmd, args) = resolve_wsl("Ubuntu");
        assert!(
            Path::new(&cmd).is_absolute(),
            "WSL path should be absolute on Windows, got: {cmd}"
        );
        assert_eq!(args, vec!["-d", "Ubuntu"]);
    }

    #[cfg(windows)]
    #[test]
    fn bash_resolves_to_git_bash_on_windows() {
        let (cmd, args) = resolve_bash();
        assert_eq!(args, vec!["--login"]);
        // If Git Bash is installed, should resolve to its absolute path
        if Path::new(r"C:\Program Files\Git\bin\bash.exe").exists()
            || Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe").exists()
        {
            assert!(
                cmd.contains("Git") && cmd.ends_with(r"\bash.exe"),
                "bash should resolve to Git Bash on Windows, got: {cmd}"
            );
        }
    }
}
