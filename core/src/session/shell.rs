//! Shell session helpers — pure-logic functions for shell command building,
//! OSC 7 CWD tracking, and initial command strategy.
//!
//! These functions extract duplicated shell-setup logic from the desktop
//! (`local_shell.rs`, `shell_detect.rs`, `manager.rs`) and agent
//! (`shell/backend.rs`, `daemon/process.rs`) crates into shared, testable
//! pure functions with no I/O, no PTY spawning, and no async.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::config::ShellConfig;

/// Well-known Git Bash installation paths on Windows.
#[cfg(windows)]
const GIT_BASH_PATHS: &[&str] = &[
    r"C:\Program Files\Git\bin\bash.exe",
    r"C:\Program Files (x86)\Git\bin\bash.exe",
];

/// Resolved shell command ready for spawning.
///
/// Contains the program path, arguments, environment variables, working
/// directory, and PTY dimensions. Consumers use this to configure their
/// platform-specific PTY spawn (portable-pty on desktop, fork+exec on agent).
#[derive(Debug, Clone)]
pub struct ShellCommand {
    /// Executable path (e.g. `/bin/zsh`, `wsl.exe`).
    pub program: String,
    /// Command-line arguments (e.g. `["--login"]`, `["-d", "Ubuntu"]`).
    pub args: Vec<String>,
    /// Environment variables to set in the child process.
    /// Always includes `TERM=xterm-256color` and `COLORTERM=truecolor`.
    pub env: HashMap<String, String>,
    /// Working directory for the shell, or `None` if unresolvable.
    pub cwd: Option<PathBuf>,
    /// PTY column count.
    pub cols: u16,
    /// PTY row count.
    pub rows: u16,
}

/// Strategy for sending an initial command to a newly spawned shell.
#[derive(Debug, Clone, PartialEq)]
pub enum InitialCommandStrategy {
    /// No initial command.
    None,
    /// Send the command immediately (caller handles timing).
    Immediate(String),
    /// Buffer output until the screen-clear sequence appears, then
    /// send the command with a short delay.
    WaitForClear(String),
    /// Send the command after a fixed delay.
    Delayed(String, Duration),
}

/// Detect the user's default shell on this platform.
///
/// On Unix, reads the `$SHELL` environment variable and extracts the
/// shell name (e.g., `/bin/zsh` -> `"zsh"`).
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

/// Resolve a shell name to the executable path and arguments.
///
/// Handles platform-specific resolution:
/// - WSL distros (`wsl:Ubuntu`, `wsl:Debian`)
/// - Git Bash on Windows (bare `bash` redirects to Git Bash to avoid WSL interception)
/// - PowerShell absolute path on Windows
/// - Standard Unix shells (`zsh`, `bash`, `sh`)
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

/// Return the user's home directory.
///
/// On Unix, reads `$HOME`. On Windows, reads `$USERPROFILE`.
pub fn home_directory() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
}

/// Build a fully resolved [`ShellCommand`] from a [`ShellConfig`].
///
/// - Resolves the shell from `config.shell` or [`detect_default_shell()`],
///   falling back to `"sh"`.
/// - Calls [`shell_to_command()`] to get the executable and arguments.
/// - Builds the environment: starts with `config.env`, inserts
///   `TERM=xterm-256color` and `COLORTERM=truecolor`.
/// - Resolves the working directory from `config.starting_directory` or
///   [`home_directory()`].
pub fn build_shell_command(config: &ShellConfig) -> ShellCommand {
    let shell = config
        .shell
        .clone()
        .or_else(detect_default_shell)
        .unwrap_or_else(|| "sh".to_string());

    let (program, args) = shell_to_command(&shell);

    let mut env = config.env.clone();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());

    let cwd = config
        .starting_directory
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(home_directory);

    ShellCommand {
        program,
        args,
        env,
        cwd,
        cols: config.cols,
        rows: config.rows,
    }
}

/// Return a shell command that configures `PROMPT_COMMAND` (bash) or
/// `precmd_functions` (zsh) to emit OSC 7 CWD escape sequences.
///
/// - `"wsl:<distro>"` — WSL variant: includes `cd $HOME` guard for `/mnt/`
///   paths and screen-clear escape.
/// - `"ssh"` — SSH variant: no `/mnt/` guard, includes screen-clear escape.
/// - `"bash"` / `"gitbash"` — local bash sessions: same as SSH variant
///   (bash does not emit OSC 7 by default).
/// - Anything else (`"zsh"`, `"powershell"`, `"cmd"`, etc.) — returns `None`
///   (zsh emits OSC 7 natively; PowerShell/cmd don't support `PROMPT_COMMAND`).
pub fn osc7_setup_command(shell_type: &str) -> Option<String> {
    if shell_type.starts_with("wsl:") {
        Some(wsl_osc7_command().to_string())
    } else if matches!(shell_type, "ssh" | "bash" | "gitbash") {
        Some(bash_osc7_command().to_string())
    } else {
        None
    }
}

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
///
/// On Unix, checks standard paths (`/bin/zsh`, `/usr/bin/bash`, etc.).
/// On Windows, includes PowerShell, cmd, and Git Bash.
///
/// WSL distributions are not included here — they are handled by the
/// dedicated WSL connection type (see `backends::wsl`).
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

/// Determine the strategy for sending an initial command to a shell.
///
/// - `None` input -> [`InitialCommandStrategy::None`]
/// - `Some(cmd)` + `wait_for_clear == true` -> [`InitialCommandStrategy::WaitForClear`]
/// - `Some(cmd)` + `wait_for_clear == false` -> [`InitialCommandStrategy::Delayed`] (200 ms)
pub fn initial_command_strategy(
    initial_command: Option<&str>,
    wait_for_clear: bool,
) -> InitialCommandStrategy {
    match initial_command {
        None => InitialCommandStrategy::None,
        Some(cmd) if wait_for_clear => InitialCommandStrategy::WaitForClear(cmd.to_string()),
        Some(cmd) => InitialCommandStrategy::Delayed(cmd.to_string(), Duration::from_millis(200)),
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// OSC 7 setup command for WSL shells.
///
/// Changes to `$HOME` when the CWD is a Windows drive mount (`/mnt/c/...`),
/// since WSL defaults to the Windows user directory which is inaccessible
/// through the `\\wsl$\` UNC share. Ends with ANSI screen-clear escape.
fn wsl_osc7_command() -> &'static str {
    concat!(
        r#"case "$PWD" in /mnt/[a-z]|/mnt/[a-z]/*) cd;; esac; "#,
        r#"__termihub_osc7(){ printf '\e]7;file://%s\a' "$PWD"; }; "#,
        r#"[ "$ZSH_VERSION" ] && precmd_functions+=(__termihub_osc7) || "#,
        r#"PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; "#,
        r#"printf '\033[2J\033[H'"#,
    )
}

/// OSC 7 setup command for bash-based shells (SSH, local bash, Git Bash).
///
/// Unlike [`wsl_osc7_command()`], this does not include a `cd $HOME` guard
/// for `/mnt/` paths. Supports both bash (`PROMPT_COMMAND`) and zsh
/// (`precmd_functions`). Ends with ANSI screen-clear escape.
fn bash_osc7_command() -> &'static str {
    concat!(
        r#"__termihub_osc7(){ printf '\e]7;file://%s\a' "$PWD"; }; "#,
        r#"[ "$ZSH_VERSION" ] && precmd_functions+=(__termihub_osc7) || "#,
        r#"PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; "#,
        r#"printf '\033[2J\033[H'"#,
    )
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

    // -----------------------------------------------------------------------
    // detect_default_shell
    // -----------------------------------------------------------------------

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
        let orig = std::env::var("SHELL").ok();
        std::env::set_var("SHELL", "/usr/bin/fish");

        let result = detect_default_shell();
        assert_eq!(result, Some("fish".to_string()));

        if let Some(val) = orig {
            std::env::set_var("SHELL", val);
        } else {
            std::env::remove_var("SHELL");
        }
    }

    #[cfg(windows)]
    #[test]
    fn detect_default_shell_returns_powershell_on_windows() {
        assert_eq!(detect_default_shell(), Some("powershell".to_string()));
    }

    // -----------------------------------------------------------------------
    // shell_to_command
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // home_directory
    // -----------------------------------------------------------------------

    #[test]
    fn home_directory_returns_some() {
        let home = home_directory();
        assert!(home.is_some(), "expected a home directory to be resolved");
    }

    // -----------------------------------------------------------------------
    // build_shell_command
    // -----------------------------------------------------------------------

    #[test]
    fn build_shell_command_default_env() {
        let config = ShellConfig::default();
        let cmd = build_shell_command(&config);
        assert_eq!(
            cmd.env.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert_eq!(
            cmd.env.get("COLORTERM").map(String::as_str),
            Some("truecolor")
        );
    }

    #[test]
    fn build_shell_command_with_explicit_shell() {
        let config = ShellConfig {
            shell: Some("zsh".to_string()),
            ..Default::default()
        };
        let cmd = build_shell_command(&config);
        assert_eq!(cmd.program, "zsh");
        assert_eq!(cmd.args, vec!["--login"]);
    }

    #[test]
    fn build_shell_command_with_starting_directory() {
        let config = ShellConfig {
            starting_directory: Some("/tmp".to_string()),
            ..Default::default()
        };
        let cmd = build_shell_command(&config);
        assert_eq!(cmd.cwd, Some(PathBuf::from("/tmp")));
    }

    #[test]
    fn build_shell_command_default_shell() {
        let config = ShellConfig::default();
        let cmd = build_shell_command(&config);
        // Should resolve to the detected default shell, not empty
        assert!(!cmd.program.is_empty());
    }

    #[test]
    fn build_shell_command_env_merged() {
        let mut env = HashMap::new();
        env.insert("MY_VAR".to_string(), "hello".to_string());

        let config = ShellConfig {
            env,
            ..Default::default()
        };
        let cmd = build_shell_command(&config);
        assert_eq!(
            cmd.env.get("MY_VAR").map(String::as_str),
            Some("hello"),
            "config env should be preserved"
        );
        assert_eq!(
            cmd.env.get("TERM").map(String::as_str),
            Some("xterm-256color"),
            "TERM should be injected"
        );
        assert_eq!(
            cmd.env.get("COLORTERM").map(String::as_str),
            Some("truecolor"),
            "COLORTERM should be injected"
        );
    }

    #[test]
    fn build_shell_command_empty_starting_directory_uses_home() {
        let config = ShellConfig {
            starting_directory: Some(String::new()),
            ..Default::default()
        };
        let cmd = build_shell_command(&config);
        // Empty string should be filtered, falling back to home
        assert_eq!(cmd.cwd, home_directory());
    }

    #[test]
    fn build_shell_command_preserves_pty_size() {
        let config = ShellConfig {
            cols: 120,
            rows: 40,
            ..Default::default()
        };
        let cmd = build_shell_command(&config);
        assert_eq!(cmd.cols, 120);
        assert_eq!(cmd.rows, 40);
    }

    // -----------------------------------------------------------------------
    // osc7_setup_command
    // -----------------------------------------------------------------------

    #[test]
    fn osc7_wsl_contains_expected_parts() {
        let setup = osc7_setup_command("wsl:Ubuntu").expect("expected Some for WSL");
        assert!(
            setup.contains(r"\e]7;"),
            "expected OSC 7 escape marker, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND"),
            "expected bash PROMPT_COMMAND, got: {setup}"
        );
        assert!(
            setup.contains("precmd_functions"),
            "expected zsh precmd_functions, got: {setup}"
        );
        // Should cd to $HOME when starting in a Windows drive mount
        assert!(
            setup.contains("/mnt/[a-z]") && setup.contains("cd"),
            "expected cd-home for /mnt/ paths, got: {setup}"
        );
        // Should use printf for screen clear (not `clear` which needs ncurses)
        assert!(
            setup.contains(r"\033[2J"),
            "expected ANSI clear-screen escape, got: {setup}"
        );
    }

    #[test]
    fn osc7_ssh_contains_expected_parts() {
        let setup = osc7_setup_command("ssh").expect("expected Some for SSH");
        assert!(
            setup.contains(r"\e]7;"),
            "expected OSC 7 escape marker, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND"),
            "expected bash PROMPT_COMMAND, got: {setup}"
        );
        assert!(
            setup.contains("precmd_functions"),
            "expected zsh precmd_functions, got: {setup}"
        );
        // Should NOT contain WSL-specific /mnt/ path handling
        assert!(
            !setup.contains("/mnt/"),
            "SSH setup should not contain /mnt/ path handling, got: {setup}"
        );
        // Should use printf for screen clear
        assert!(
            setup.contains(r"\033[2J"),
            "expected ANSI clear-screen escape, got: {setup}"
        );
    }

    #[test]
    fn osc7_bash_contains_expected_parts() {
        let setup = osc7_setup_command("bash").expect("expected Some for bash");
        assert!(
            setup.contains(r"\e]7;"),
            "expected OSC 7 escape marker, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND"),
            "expected bash PROMPT_COMMAND, got: {setup}"
        );
        // Should NOT contain WSL-specific /mnt/ path handling
        assert!(
            !setup.contains("/mnt/"),
            "local bash setup should not contain /mnt/ path handling, got: {setup}"
        );
    }

    #[test]
    fn osc7_gitbash_contains_expected_parts() {
        let setup = osc7_setup_command("gitbash").expect("expected Some for gitbash");
        assert!(
            setup.contains(r"\e]7;"),
            "expected OSC 7 escape marker, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND"),
            "expected bash PROMPT_COMMAND, got: {setup}"
        );
    }

    #[test]
    fn osc7_non_bash_returns_none() {
        assert!(osc7_setup_command("zsh").is_none());
        assert!(osc7_setup_command("powershell").is_none());
        assert!(osc7_setup_command("cmd").is_none());
        assert!(osc7_setup_command("sh").is_none());
    }

    // -----------------------------------------------------------------------
    // initial_command_strategy
    // -----------------------------------------------------------------------

    #[test]
    fn initial_command_none() {
        let strategy = initial_command_strategy(None, false);
        assert_eq!(strategy, InitialCommandStrategy::None);
    }

    #[test]
    fn initial_command_none_with_clear_flag() {
        let strategy = initial_command_strategy(None, true);
        assert_eq!(strategy, InitialCommandStrategy::None);
    }

    #[test]
    fn initial_command_with_clear() {
        let strategy = initial_command_strategy(Some("echo hello"), true);
        assert_eq!(
            strategy,
            InitialCommandStrategy::WaitForClear("echo hello".to_string())
        );
    }

    #[test]
    fn initial_command_without_clear() {
        let strategy = initial_command_strategy(Some("echo hello"), false);
        assert_eq!(
            strategy,
            InitialCommandStrategy::Delayed("echo hello".to_string(), Duration::from_millis(200))
        );
    }

    // -----------------------------------------------------------------------
    // Platform-specific helper tests
    // -----------------------------------------------------------------------

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
        if Path::new(r"C:\Program Files\Git\bin\bash.exe").exists()
            || Path::new(r"C:\Program Files (x86)\Git\bin\bash.exe").exists()
        {
            assert!(
                cmd.contains("Git") && cmd.ends_with(r"\bash.exe"),
                "bash should resolve to Git Bash on Windows, got: {cmd}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // detect_available_shells
    // -----------------------------------------------------------------------

    #[test]
    fn detect_available_shells_returns_non_empty() {
        let shells = detect_available_shells();
        assert!(
            !shells.is_empty(),
            "expected at least one shell to be detected"
        );
    }

    #[cfg(unix)]
    #[test]
    fn detect_available_shells_contains_known_unix_shell() {
        let shells = detect_available_shells();
        // At least one of bash, zsh, or sh should be present on any Unix system
        assert!(
            shells
                .iter()
                .any(|s| s == "bash" || s == "zsh" || s == "sh"),
            "expected bash, zsh, or sh in detected shells: {:?}",
            shells
        );
    }

    #[cfg(windows)]
    #[test]
    fn detect_available_shells_contains_powershell_on_windows() {
        let shells = detect_available_shells();
        assert!(
            shells.contains(&"powershell".to_string()),
            "expected powershell in detected shells: {:?}",
            shells
        );
    }

    /// Regression test for #400: WSL distros must not appear in local shells.
    #[test]
    fn detect_available_shells_excludes_wsl() {
        let shells = detect_available_shells();
        for shell in &shells {
            assert!(
                !shell.starts_with("wsl:"),
                "WSL distro '{shell}' should not appear in local shells (issue #400)"
            );
        }
    }

    // -----------------------------------------------------------------------
    // parse_wsl_output
    // -----------------------------------------------------------------------

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
}
