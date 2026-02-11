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
        "zsh" => ("zsh", vec![]),
        "bash" => ("bash", vec![]),
        "sh" => ("sh", vec![]),
        "cmd" => ("cmd.exe", vec![]),
        "powershell" => ("powershell.exe", vec!["-NoLogo"]),
        "gitbash" => ("bash.exe", vec!["--login"]),
        _ => ("sh", vec![]),
    }
}
