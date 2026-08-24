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

use crate::config::{home_directory, ShellConfig};

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
        "fish" => ("fish".into(), vec!["--login".into()]),
        "nushell" => ("nu".into(), vec!["--login".into()]),
        other => {
            // If the value looks like a file path, use it as a literal executable.
            // This supports custom shell paths (e.g. "/opt/myshell/bin/mysh").
            // Otherwise, pass through the name as-is so any shell in PATH works
            // instead of silently falling back to sh.
            if other.contains('/') || other.contains('\\') {
                (other.to_string(), vec![])
            } else {
                (other.into(), vec![])
            }
        }
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

/// Return a shell command that enables CWD tracking for the given shell.
///
/// POSIX-compatible shells use **OSC 7** (`file://` URI), which is the
/// cross-platform standard emitted natively by zsh and injected via
/// `PROMPT_COMMAND` / `precmd_functions` for bash variants.
///
/// Native Windows shells use **OSC 9;9** (Windows Terminal standard), which
/// carries the raw Windows path with no URL encoding or slash conversion.
///
/// - `"wsl:<distro>"` — OSC 7, WSL variant: `cd $HOME` guard for `/mnt/`
///   paths; injected visibly via the WSL temp-file source mechanism.
/// - `"ssh"` — OSC 7, SSH variant: no `/mnt/` guard; injected visibly via
///   stdin.
/// - `"bash"` / `"gitbash"` / `"zsh"` — OSC 7; uses `if [ -n "$ZSH_VERSION" ]`
///   to route zsh to `precmd_functions` and bash to `PROMPT_COMMAND`;
///   injected visibly via stdin.
/// - `"powershell"` — OSC 9;9: overrides the `prompt` function; injected via
///   `-NoExit -Command` startup args (not stdin) to avoid echo.
/// - `"cmd"` — OSC 9;9: sets the `PROMPT` variable via `/K` startup arg
///   (not stdin) to avoid echo.
/// - Anything else (`"sh"`, etc.) — `None`.
pub fn osc7_setup_command(shell_type: &str) -> Option<&'static str> {
    if shell_type.starts_with("wsl:") {
        Some(wsl_osc7_command())
    } else if matches!(shell_type, "ssh" | "bash" | "gitbash" | "zsh") {
        Some(bash_osc7_command())
    } else if shell_type == "powershell" {
        Some(powershell_osc9_command())
    } else if shell_type == "cmd" {
        Some(cmd_osc9_command())
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
        .as_chunks::<2>()
        .0
        .iter()
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
            ("/usr/local/bin/fish", "fish"),
            ("/usr/bin/fish", "fish"),
            ("/opt/homebrew/bin/fish", "fish"),
            ("/usr/local/bin/nu", "nushell"),
            ("/usr/bin/nu", "nushell"),
            ("/opt/homebrew/bin/nu", "nushell"),
            ("/usr/local/bin/pwsh", "powershell"),
            ("/usr/bin/pwsh", "powershell"),
            ("/snap/bin/pwsh", "powershell"),
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

        // Check for Git Bash across every known install location (registry,
        // user-scope, PATH, scoop, Program Files) — shares the same resolver
        // as launch, so what we offer is exactly what we launch.
        if resolve_git_bash_path().is_some() {
            shells.push("gitbash".to_string());
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

/// Shared bash/zsh fragment: define `__termihub_osc7` and register it as a
/// prompt hook. Spliced verbatim into both [`wsl_osc7_command`] and
/// [`bash_osc7_command`]. It is a `macro_rules!` rather than a `fn`/`const`
/// because both callers embed it in a `concat!`, which accepts only literals.
///
/// The `if/else/fi` (not `&&…||`) isolates the zsh and bash paths: a non-zero
/// `precmd_functions+=` must not fall through to set `PROMPT_COMMAND`, and in
/// zsh `${PROMPT_COMMAND:+…}` inside double quotes could otherwise produce
/// unbalanced quotes and strand the shell at the `>` secondary prompt.
///
/// # Array-aware `PROMPT_COMMAND` (issue #1029)
///
/// bash 5.1+ allows `PROMPT_COMMAND` to be an array whose elements are each
/// executed before the prompt, and distros increasingly ship it that way —
/// Fedora, for instance, declares `declare -a PROMPT_COMMAND=([0]=<title>
/// [1]=<systemd OSC context>)` and provides no `vte.sh` OSC 7 emitter at all.
/// A bare scalar assignment (`PROMPT_COMMAND="…"`) targets element `[0]` of
/// such an array, silently rewriting an existing hook instead of adding ours,
/// so we probe the type via `declare -p` and append with
/// `PROMPT_COMMAND+=(__termihub_osc7)` for arrays. bash normalizes `declare -p`
/// so array flags always begin `declare -a…` (even `declare -xa` prints as
/// `declare -ax`), making the `"declare -a"*` prefix match exact — it never
/// matches a scalar, including one whose value contains the letter `a`.
macro_rules! osc7_bash_prompt_hook {
    () => {
        concat!(
            r#"__termihub_osc7(){ printf '\e]7;file://%s\a' "$PWD"; }; "#,
            r#"if [ -n "$ZSH_VERSION" ]; then "#,
            r#"precmd_functions+=(__termihub_osc7); "#,
            r#"else "#,
            r#"case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "#,
            r#""declare -a"*) PROMPT_COMMAND+=(__termihub_osc7);; "#,
            r#"*) PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; "#,
            r#"esac; "#,
            r#"fi"#,
        )
    };
}

/// OSC 7 setup command for WSL shells.
///
/// Changes to `$HOME` when the CWD is a Windows drive mount (`/mnt/c/...`),
/// since WSL defaults to the Windows user directory which is inaccessible
/// through the `\\wsl$\` UNC share. The prompt-hook registration itself is
/// shared with [`bash_osc7_command`] via [`osc7_bash_prompt_hook`].
/// Injected via the WSL temp-file source mechanism in `wsl.rs`.
fn wsl_osc7_command() -> &'static str {
    concat!(
        r#"echo '# [termiHub] Shell integration: setting up OSC 7 CWD tracking'; "#,
        r#"case "$PWD" in /mnt/[a-z]|/mnt/[a-z]/*) cd;; esac; "#,
        osc7_bash_prompt_hook!(),
    )
}

/// OSC 7 setup command for bash-based shells (SSH, local bash, Git Bash).
///
/// Unlike [`wsl_osc7_command`], this omits the `cd $HOME` guard for `/mnt/`
/// paths. The prompt-hook registration (bash + zsh, array-aware
/// `PROMPT_COMMAND`) is shared via [`osc7_bash_prompt_hook`].
fn bash_osc7_command() -> &'static str {
    concat!(
        r#"echo '# [termiHub] Shell integration: setting up OSC 7 CWD tracking'; "#,
        osc7_bash_prompt_hook!(),
    )
}

/// OSC 9;9 setup command for PowerShell (both `powershell.exe` and `pwsh`).
///
/// Overrides the built-in `prompt` function to emit an OSC 9;9 CWD sequence
/// before each prompt. OSC 9;9 is the Windows Terminal native CWD sequence:
/// it carries the raw Windows path (`C:\foo`) with no URL encoding or
/// backslash conversion required. Ends with `Clear-Host` to clear the screen.
/// Injected via `-NoExit -Command` startup args so the command never echoes.
fn powershell_osc9_command() -> &'static str {
    concat!(
        r#"function prompt{"#,
        r#"[Console]::Write([char]27+']9;9;'+$PWD.Path+[char]7);"#,
        r#""PS $($PWD.Path)> "};Clear-Host"#,
    )
}

/// OSC 9;9 setup command for cmd.exe.
///
/// Sets the `PROMPT` variable to embed an OSC 9;9 CWD sequence before each
/// prompt. In cmd's PROMPT syntax: `$E` expands to ESC (0x1B), `$P` to the
/// current drive and path (e.g. `C:\Users\foo`), `$G` to `>`, and `$E\`
/// forms the OSC String Terminator (`ESC \`). OSC 9;9 carries the raw Windows
/// path — no URL encoding or slash conversion needed. Ends with `cls` to clear
/// the screen. Injected via `/K` startup arg so the command never echoes.
fn cmd_osc9_command() -> &'static str {
    r"PROMPT=$E]9;9;$P$E\$P$G & cls"
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

/// Resolve the full path to PowerShell.
///
/// On Windows, prefers the absolute path under `SYSTEMROOT`.
/// On Unix, uses `pwsh` (the cross-platform PowerShell executable name).
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
        return ("powershell.exe".into(), vec!["-NoLogo".into()]);
    }
    #[cfg(unix)]
    {
        return ("pwsh".into(), vec!["-NoLogo".into()]);
    }
    #[allow(unreachable_code)]
    ("powershell.exe".into(), vec!["-NoLogo".into()])
}

/// Resolve the full path to Git Bash on Windows.
///
/// Probes every known install location (see [`git_bash_candidates`]) in
/// priority order. Falls back to the bare `bash.exe` name when no install is
/// found, and on non-Windows platforms.
fn resolve_git_bash() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if let Some(path) = resolve_git_bash_path() {
            return (path.to_string_lossy().into_owned(), vec!["--login".into()]);
        }
    }
    ("bash.exe".into(), vec!["--login".into()])
}

/// Return the first candidate for which `exists` reports true, preserving the
/// candidate order (highest-priority install location first).
///
/// Pure and platform-agnostic: the caller injects both the ordered candidate
/// list and the existence predicate, which is what makes the Windows Git Bash
/// resolution order unit-testable on any platform (the predicate stands in for
/// the filesystem). Compiled on Windows (where it drives resolution) and under
/// `test` (so the order is exercised on every CI platform).
#[cfg(any(windows, test))]
fn first_existing_path(candidates: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<&PathBuf> {
    candidates.iter().find(|p| exists(p.as_path()))
}

/// Remove duplicate paths while preserving first-seen order.
///
/// Two probes can legitimately point at the same install (e.g. the registry's
/// `InstallPath` and a hardcoded `Program Files` fallback), so the candidate
/// list is de-duplicated before probing to avoid redundant existence checks.
#[cfg(any(windows, test))]
fn dedup_preserving_order(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|p| seen.insert(p.clone()))
        .collect()
}

/// Resolve the concrete Git Bash `bash.exe` path on Windows, probing every
/// known install location in priority order. `None` when Git Bash is not found.
///
/// Single source of truth: both [`resolve_git_bash`] (launch) and
/// [`detect_available_shells`] (offer the `gitbash` option) go through this, so
/// a detected install and a launched install can never disagree.
#[cfg(windows)]
fn resolve_git_bash_path() -> Option<PathBuf> {
    let candidates = git_bash_candidates();
    first_existing_path(&candidates, |p| p.exists()).cloned()
}

/// Build the ordered list of Git Bash (`bash.exe`) locations to probe, most
/// reliable / most specific first:
///
/// 1. Git for Windows registry `InstallPath` (HKCU, then HKLM, incl. the 32-bit
///    `WOW6432Node` view) → `<InstallPath>\bin\bash.exe`
/// 2. User-scope install → `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
/// 3. PATH-derived: locate `git.exe` and derive its sibling
///    `<git-root>\bin\bash.exe` (covers winget / choco / custom installs)
/// 4. scoop per-user shim → `%USERPROFILE%\scoop\apps\git\current\bin\bash.exe`
/// 5. The two well-known `Program Files` fallbacks ([`GIT_BASH_PATHS`])
///
/// The list is de-duplicated (order preserved) so an install found by two
/// probes is only tried once.
#[cfg(windows)]
fn git_bash_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // 1. Registry InstallPath (user-scope HKCU first, then machine-scope HKLM).
    candidates.extend(registry_git_install_paths());

    // 2. User-scope install under LOCALAPPDATA (winget --scope user, portable).
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }

    // 3. PATH-derived: git.exe -> <install-root>\bin\bash.exe.
    if let Some(bash) = git_bash_from_path() {
        candidates.push(bash);
    }

    // 4. scoop per-user install.
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        candidates.push(
            PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join("git")
                .join("current")
                .join("bin")
                .join("bash.exe"),
        );
    }

    // 5. Hardcoded Program Files fallbacks (machine-scope default installs).
    candidates.extend(GIT_BASH_PATHS.iter().map(PathBuf::from));

    dedup_preserving_order(candidates)
}

/// Read Git for Windows' `InstallPath` value from the registry and map each hit
/// to `<InstallPath>\bin\bash.exe`. Checks HKCU (user-scope installs) before
/// HKLM (machine-scope), plus the 32-bit `WOW6432Node` view of HKLM.
#[cfg(windows)]
fn registry_git_install_paths() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let lookups = [
        (HKEY_CURRENT_USER, r"SOFTWARE\GitForWindows"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\GitForWindows"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\GitForWindows"),
    ];

    let mut paths = Vec::new();
    for (hive, subkey) in lookups {
        if let Ok(key) = RegKey::predef(hive).open_subkey(subkey) {
            if let Ok(install_path) = key.get_value::<String, _>("InstallPath") {
                paths.push(PathBuf::from(install_path).join("bin").join("bash.exe"));
            }
        }
    }
    paths
}

/// Locate `git.exe` on `PATH` and derive the sibling Git Bash.
///
/// Git for Windows places `git.exe` in `<install-root>\cmd` (and also
/// `<install-root>\bin`); in either case the install root is the grandparent
/// directory and `bash.exe` lives in `<install-root>\bin`.
#[cfg(windows)]
fn git_bash_from_path() -> Option<PathBuf> {
    let git_exe = which::which("git").ok()?;
    let install_root = git_exe.parent()?.parent()?;
    Some(install_root.join("bin").join("bash.exe"))
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
        #[cfg(unix)]
        assert_eq!(cmd, "pwsh");
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
    fn shell_to_command_unknown_passes_through() {
        let (cmd, args) = shell_to_command("elvish");
        assert_eq!(cmd, "elvish");
        assert!(args.is_empty());
    }

    #[test]
    fn shell_to_command_fish() {
        let (cmd, args) = shell_to_command("fish");
        assert_eq!(cmd, "fish");
        assert_eq!(args, vec!["--login"]);
    }

    #[test]
    fn shell_to_command_nushell() {
        let (cmd, args) = shell_to_command("nushell");
        assert_eq!(cmd, "nu");
        assert_eq!(args, vec!["--login"]);
    }

    #[test]
    fn shell_to_command_custom_path() {
        let (cmd, args) = shell_to_command("/usr/local/bin/myshell");
        assert_eq!(cmd, "/usr/local/bin/myshell");
        assert!(args.is_empty());
    }

    #[test]
    fn shell_to_command_windows_custom_path() {
        let (cmd, args) = shell_to_command(r"C:\shells\myshell.exe");
        assert_eq!(cmd, r"C:\shells\myshell.exe");
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
        // Should contain visible notice message
        assert!(
            setup.contains("[termiHub]"),
            "expected visible notice, got: {setup}"
        );
        // Must not use full screen clear
        assert!(
            !setup.contains(r"\033[2J"),
            "must not use full screen clear, got: {setup}"
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
        // Should contain visible notice message
        assert!(
            setup.contains("[termiHub]"),
            "expected visible notice, got: {setup}"
        );
        // Must not use full screen clear
        assert!(
            !setup.contains(r"\033[2J"),
            "must not use full screen clear, got: {setup}"
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
        assert!(osc7_setup_command("sh").is_none());
    }

    #[test]
    fn osc7_zsh_contains_expected_parts() {
        let setup = osc7_setup_command("zsh").expect("expected Some for zsh");
        assert!(
            setup.contains(r"\e]7;"),
            "expected OSC 7 escape marker, got: {setup}"
        );
        assert!(
            setup.contains("ZSH_VERSION"),
            "expected zsh detection via ZSH_VERSION, got: {setup}"
        );
        assert!(
            setup.contains("precmd_functions"),
            "expected zsh precmd_functions hook, got: {setup}"
        );
    }

    /// Regression: ZSH must not reach the PROMPT_COMMAND assignment.
    ///
    /// Previously, the script used `[ "$ZSH_VERSION" ] && precmd_functions+=... || PROMPT_COMMAND=...`.
    /// If `precmd_functions+=` returned non-zero for any reason, the `||` fallback
    /// would set PROMPT_COMMAND to a string that could contain unbalanced double quotes
    /// (from `${PROMPT_COMMAND:+;$PROMPT_COMMAND}` expansion), leaving ZSH at the `>`
    /// secondary prompt with no way to type.
    ///
    /// The fix uses `if...else...fi` so PROMPT_COMMAND is only set in the bash branch.
    #[test]
    fn osc7_zsh_uses_if_else_not_and_or_for_precmd() {
        let setup = osc7_setup_command("zsh").expect("expected Some for zsh");

        assert!(
            setup.contains("if [") || setup.contains("if["),
            "ZSH setup must use if statement (not &&/||): {setup}"
        );

        // precmd_functions must be in the then-branch (before else)
        let else_pos = setup.find("else").unwrap_or(setup.len());
        let then_part = &setup[..else_pos];
        let else_part = &setup[else_pos..];

        assert!(
            then_part.contains("precmd_functions"),
            "precmd_functions must be in the then-branch (before else): {setup}"
        );

        // PROMPT_COMMAND must only appear in the else-branch (bash path)
        assert!(
            !then_part.contains("PROMPT_COMMAND"),
            "PROMPT_COMMAND must NOT be reachable in ZSH (then-branch): {setup}"
        );
        assert!(
            else_part.contains("PROMPT_COMMAND"),
            "PROMPT_COMMAND must be in the else-branch (bash-only path): {setup}"
        );
    }

    /// Regression for #1029: bash 5.1+ supports an **array** `PROMPT_COMMAND`
    /// (e.g. Fedora, which declares `declare -a PROMPT_COMMAND=(...)` and ships
    /// no `vte.sh`). The old scalar assignment only mutated element `[0]` of
    /// such an array — fragile shell integration. The bash branch must detect
    /// the array case via `declare -p` and append the hook with
    /// `PROMPT_COMMAND+=(...)`. (ssh/gitbash/zsh share this command via the
    /// dispatch in [`osc7_setup_command`], covered by the *_contains_* tests.)
    #[test]
    fn osc7_bash_handles_array_prompt_command() {
        let setup = osc7_setup_command("bash").expect("expected Some for bash");
        assert!(
            setup.contains("declare -p PROMPT_COMMAND"),
            "must probe PROMPT_COMMAND type via declare -p, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND+=(__termihub_osc7)"),
            "must array-append the hook when PROMPT_COMMAND is an array, got: {setup}"
        );
        // The scalar fallback (non-array) must still be present.
        assert!(
            setup
                .contains(r#"PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}""#),
            "must keep the scalar-string fallback, got: {setup}"
        );
    }

    /// Regression for #1029: the WSL variant must also be array-aware, since
    /// Fedora is a WSL-hosted distro that uses an array `PROMPT_COMMAND`.
    #[test]
    fn osc7_wsl_handles_array_prompt_command() {
        let setup = osc7_setup_command("wsl:FedoraLinux-44").expect("expected Some for WSL");
        assert!(
            setup.contains("declare -p PROMPT_COMMAND"),
            "WSL: must probe PROMPT_COMMAND type via declare -p, got: {setup}"
        );
        assert!(
            setup.contains("PROMPT_COMMAND+=(__termihub_osc7)"),
            "WSL: must array-append the hook when PROMPT_COMMAND is an array, got: {setup}"
        );
    }

    #[test]
    fn osc9_cmd_contains_expected_parts() {
        let setup = osc7_setup_command("cmd").expect("expected Some for cmd");
        // Must set the PROMPT variable
        assert!(
            setup.contains("PROMPT="),
            "expected PROMPT assignment, got: {setup}"
        );
        // Must embed OSC 9;9 marker ($E = ESC, no URL encoding needed)
        assert!(
            setup.contains("$E]9;9;"),
            "expected OSC 9;9 marker via $E, got: {setup}"
        );
        // Must include current path via $P (raw Windows path, no conversion)
        assert!(
            setup.contains("$P"),
            "expected $P (current path) in PROMPT, got: {setup}"
        );
        // Must clear screen at end
        assert!(setup.contains("cls"), "expected cls at end, got: {setup}");
    }

    #[test]
    fn osc9_powershell_contains_expected_parts() {
        let setup = osc7_setup_command("powershell").expect("expected Some for powershell");
        // Must redefine the prompt function
        assert!(
            setup.contains("function prompt"),
            "expected prompt function override, got: {setup}"
        );
        // Must emit OSC 9;9 sequence (raw Windows path, no URL conversion)
        assert!(
            setup.contains("]9;9;"),
            "expected OSC 9;9 marker, got: {setup}"
        );
        assert!(
            setup.contains("[char]27"),
            "expected ESC via [char]27, got: {setup}"
        );
        assert!(
            setup.contains("[char]7"),
            "expected BEL via [char]7, got: {setup}"
        );
        // Must NOT do backslash conversion (OSC 9;9 carries raw Windows paths)
        assert!(
            !setup.contains(r#"-replace '\\','/'"#),
            "OSC 9;9 should not convert backslashes, got: {setup}"
        );
        // Must clear screen at end
        assert!(
            setup.contains("Clear-Host"),
            "expected Clear-Host at end, got: {setup}"
        );
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
    // Git Bash resolution order (first_existing_path / dedup_preserving_order)
    // -----------------------------------------------------------------------

    #[test]
    fn first_existing_path_returns_first_present_in_order() {
        let candidates = vec![
            PathBuf::from(r"C:\absent\a\bin\bash.exe"),
            PathBuf::from(r"C:\present\b\bin\bash.exe"),
            PathBuf::from(r"C:\present\c\bin\bash.exe"),
        ];
        let present = [
            PathBuf::from(r"C:\present\b\bin\bash.exe"),
            PathBuf::from(r"C:\present\c\bin\bash.exe"),
        ];
        let got = first_existing_path(&candidates, |p| present.iter().any(|q| q == p));
        assert_eq!(got, Some(&PathBuf::from(r"C:\present\b\bin\bash.exe")));
    }

    #[test]
    fn first_existing_path_priority_wins_over_later_matches() {
        // Even when every candidate exists, the earliest (highest-priority) one
        // is returned — this is the whole point of the ordering.
        let candidates = vec![
            PathBuf::from(r"C:\registry\Git\bin\bash.exe"),
            PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        ];
        let got = first_existing_path(&candidates, |_| true);
        assert_eq!(got, Some(&PathBuf::from(r"C:\registry\Git\bin\bash.exe")));
    }

    #[test]
    fn first_existing_path_none_when_all_absent() {
        let candidates = vec![
            PathBuf::from(r"C:\a\bash.exe"),
            PathBuf::from(r"C:\b\bash.exe"),
        ];
        assert_eq!(first_existing_path(&candidates, |_| false), None);
    }

    #[test]
    fn first_existing_path_uses_real_filesystem_existence() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing-bash.exe");
        let present = dir.path().join("present-bash.exe");
        std::fs::write(&present, b"#!/bin/sh\n").expect("write present");
        let candidates = vec![missing, present.clone()];
        let got = first_existing_path(&candidates, |p| p.exists());
        assert_eq!(got, Some(&present));
    }

    #[test]
    fn dedup_preserving_order_removes_later_duplicates() {
        let input = vec![
            PathBuf::from(r"C:\a"),
            PathBuf::from(r"C:\b"),
            PathBuf::from(r"C:\a"),
            PathBuf::from(r"C:\c"),
            PathBuf::from(r"C:\b"),
        ];
        let out = dedup_preserving_order(input);
        assert_eq!(
            out,
            vec![
                PathBuf::from(r"C:\a"),
                PathBuf::from(r"C:\b"),
                PathBuf::from(r"C:\c"),
            ]
        );
    }

    /// The full candidate list must include the hardcoded `Program Files`
    /// fallbacks and be de-duplicated, whatever the machine's install layout.
    #[cfg(windows)]
    #[test]
    fn git_bash_candidates_include_fallbacks_and_are_deduped() {
        let candidates = git_bash_candidates();
        let as_str: Vec<String> = candidates
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        for fallback in GIT_BASH_PATHS {
            assert!(
                as_str.iter().any(|c| c == fallback),
                "expected hardcoded fallback {fallback} among candidates: {as_str:?}"
            );
        }
        let mut seen = std::collections::HashSet::new();
        assert!(
            candidates.iter().all(|p| seen.insert(p.clone())),
            "candidate list must be de-duplicated: {as_str:?}"
        );
    }

    /// `resolve_git_bash_path` and the `gitbash` entry from
    /// `detect_available_shells` are the same source of truth: the shell is
    /// offered iff a concrete `bash.exe` resolves.
    #[cfg(windows)]
    #[test]
    fn detect_gitbash_matches_resolver() {
        let resolved = resolve_git_bash_path().is_some();
        let offered = detect_available_shells().contains(&"gitbash".to_string());
        assert_eq!(
            resolved, offered,
            "gitbash offered={offered} but resolver present={resolved} — must agree"
        );
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

    #[cfg(unix)]
    #[test]
    fn resolve_powershell_returns_pwsh_on_unix() {
        let (cmd, args) = resolve_powershell();
        assert_eq!(cmd, "pwsh", "expected 'pwsh' on Unix, got: {cmd}");
        assert_eq!(args, vec!["-NoLogo"]);
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
