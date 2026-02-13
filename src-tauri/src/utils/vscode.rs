use std::process::Command;

/// Check if VS Code CLI (`code`) is available on PATH.
pub fn is_vscode_available() -> bool {
    Command::new("code")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Open a file in VS Code (fire-and-forget, no waiting).
pub fn open_in_vscode(path: &str) -> Result<(), std::io::Error> {
    Command::new("code").arg(path).spawn().map(|_| ())
}

/// Open a file in VS Code and wait for the editor tab to close.
pub fn open_in_vscode_wait(path: &str) -> Result<(), std::io::Error> {
    let status = Command::new("code").arg("--wait").arg(path).status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("VS Code exited with error"))
    }
}
