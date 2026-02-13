use std::path::Path;

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
        let git_bash_paths = [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ];
        for path in &git_bash_paths {
            if Path::new(path).exists() {
                shells.push("gitbash".to_string());
                break;
            }
        }
    }

    shells
}

/// Resolve a shell name to the executable path.
pub fn shell_to_command(shell: &str) -> (&str, Vec<&str>) {
    match shell {
        "zsh" => ("zsh", vec!["--login"]),
        "bash" => ("bash", vec!["--login"]),
        "sh" => ("sh", vec![]),
        "cmd" => ("cmd.exe", vec![]),
        "powershell" => ("powershell.exe", vec!["-NoLogo"]),
        "gitbash" => ("bash.exe", vec!["--login"]),
        _ => ("sh", vec![]),
    }
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
        assert_eq!(cmd, "bash");
        assert_eq!(args, vec!["--login"]);
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
        assert_eq!(cmd, "powershell.exe");
        assert_eq!(args, vec!["-NoLogo"]);
    }

    #[test]
    fn shell_to_command_gitbash() {
        let (cmd, args) = shell_to_command("gitbash");
        assert_eq!(cmd, "bash.exe");
        assert_eq!(args, vec!["--login"]);
    }

    #[test]
    fn shell_to_command_unknown_falls_back_to_sh() {
        let (cmd, args) = shell_to_command("fish");
        assert_eq!(cmd, "sh");
        assert!(args.is_empty());
    }
}
