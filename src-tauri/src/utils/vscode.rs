use std::process::Command;

/// Build a `Command` that invokes the VS Code CLI (`code`) in a
/// platform-appropriate way.
///
/// On Windows, `code` is installed as `code.cmd` which
/// `CreateProcessW` cannot resolve directly. We delegate to
/// `cmd.exe /c code` so the shell handles `.cmd` extension lookup.
fn vscode_command() -> Command {
    vscode_command_impl()
}

#[cfg(windows)]
fn vscode_command_impl() -> Command {
    let mut cmd = Command::new("cmd");
    cmd.args(["/c", "code"]);
    cmd
}

#[cfg(not(windows))]
fn vscode_command_impl() -> Command {
    Command::new("code")
}

/// Check if VS Code CLI (`code`) is available on PATH.
pub fn is_vscode_available() -> bool {
    vscode_command()
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Open a file in VS Code (fire-and-forget, no waiting).
pub fn open_in_vscode(path: &str) -> Result<(), std::io::Error> {
    vscode_command().arg(path).spawn().map(|_| ())
}

/// Open a file in VS Code and wait for the editor tab to close.
pub fn open_in_vscode_wait(path: &str) -> Result<(), std::io::Error> {
    let status = vscode_command().arg("--wait").arg(path).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("VS Code exited with error"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vscode_command_has_correct_program() {
        let cmd = vscode_command();
        let program = cmd.get_program().to_string_lossy().to_string();

        if cfg!(windows) {
            assert_eq!(program, "cmd");
        } else {
            assert_eq!(program, "code");
        }
    }

    #[test]
    fn vscode_command_has_correct_base_args() {
        let cmd = vscode_command();
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();

        if cfg!(windows) {
            assert_eq!(args, vec!["/c", "code"]);
        } else {
            assert!(args.is_empty());
        }
    }
}
