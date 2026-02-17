use std::path::Path;

/// Well-known Git Bash installation paths on Windows.
#[cfg(windows)]
const GIT_BASH_PATHS: &[&str] = &[
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
];

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
    }

    shells
}

/// Resolve a shell name to the executable path and arguments.
///
/// On Windows, returns full paths for PowerShell and Git Bash to avoid
/// misrouting through WSL (which intercepts bare `bash.exe` and can
/// interfere with `powershell.exe` lookups).
pub fn shell_to_command(shell: &str) -> (String, Vec<String>) {
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
