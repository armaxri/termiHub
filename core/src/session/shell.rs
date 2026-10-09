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
/// On Windows, uses the same selection as the agent
/// ([`detect_windows_default_shell`]: `pwsh` -> `powershell` -> `cmd`) and
/// reports it as a shell kind (`"pwsh"`, `"powershell"` or `"cmd"`), so the
/// desktop and the agent agree on the default (#3728).
pub fn detect_default_shell() -> Option<String> {
    #[cfg(unix)]
    {
        return shell_name_from_env(std::env::var("SHELL").ok().as_deref());
    }

    #[cfg(windows)]
    {
        return Some(shell_kind(&detect_windows_default_shell()).to_string());
    }

    #[allow(unreachable_code)]
    None
}

/// Windows shell executables probed on `PATH`, in preference order:
/// PowerShell 7 (`pwsh.exe`) first, then Windows PowerShell (`powershell.exe`).
/// `cmd.exe` is resolved separately via `%COMSPEC%` (see
/// [`windows_shell_candidates`]).
pub const WINDOWS_PATH_SHELLS: &[&str] = &["pwsh.exe", "powershell.exe"];

/// Last-resort Windows shell when neither PowerShell nor `%COMSPEC%` resolves.
pub const WINDOWS_FALLBACK_SHELL: &str = "cmd.exe";

/// Look up `exe` in the directories of a `PATH`-style value.
///
/// Returns the first `<dir>/<exe>` that is an existing file. The separator is
/// the host's (`;` on Windows, `:` elsewhere), as understood by
/// [`std::env::split_paths`]. Empty entries are skipped.
///
/// The filesystem probe is injected via `is_file` so the lookup is
/// unit-testable on any platform without touching the real `PATH`.
pub fn find_in_path(
    exe: &str,
    path_var: Option<&std::ffi::OsStr>,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let path_var = path_var?;
    std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(exe))
        .find(|candidate| is_file(candidate))
}

/// List the usable Windows shells as executable paths, most preferred first.
///
/// Order: `pwsh.exe` (PowerShell 7) on `PATH`, `powershell.exe` (Windows
/// PowerShell) on `PATH`, then `cmd.exe` from `%COMSPEC%` (only when that
/// value names an existing file). Only shells that were actually found are
/// returned, so the list may be empty.
///
/// Pure selection logic: `find_on_path` resolves an executable name to a path
/// and `is_file` checks `%COMSPEC%`. Both are injected so this runs in tests on
/// every platform. Used by the agent to pick its "Default Shell" and to report
/// its available shells on a Windows host (#3727).
pub fn windows_shell_candidates(
    find_on_path: impl Fn(&str) -> Option<PathBuf>,
    comspec: Option<&str>,
    is_file: impl Fn(&Path) -> bool,
) -> Vec<String> {
    let mut shells: Vec<String> = WINDOWS_PATH_SHELLS
        .iter()
        .filter_map(|exe| find_on_path(exe))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Some(comspec) = comspec.map(str::trim).filter(|c| !c.is_empty()) {
        if is_file(Path::new(comspec)) && !shells.iter().any(|s| s == comspec) {
            shells.push(comspec.to_string());
        }
    }
    shells
}

/// Pick the default Windows shell executable: the first of
/// [`windows_shell_candidates`], or [`WINDOWS_FALLBACK_SHELL`] when none was
/// found.
pub fn select_windows_default_shell(
    find_on_path: impl Fn(&str) -> Option<PathBuf>,
    comspec: Option<&str>,
    is_file: impl Fn(&Path) -> bool,
) -> String {
    windows_shell_candidates(find_on_path, comspec, is_file)
        .into_iter()
        .next()
        .unwrap_or_else(|| WINDOWS_FALLBACK_SHELL.to_string())
}

/// The shell kind of [`select_windows_default_shell`]'s pick: `"pwsh"`,
/// `"powershell"` or `"cmd"`. Pure (probes injected) so the preference order is
/// testable on every platform (#3728).
pub fn windows_default_shell_kind(
    find_on_path: impl Fn(&str) -> Option<PathBuf>,
    comspec: Option<&str>,
    is_file: impl Fn(&Path) -> bool,
) -> String {
    shell_kind(&select_windows_default_shell(
        find_on_path,
        comspec,
        is_file,
    ))
    .to_string()
}

/// The shell kinds offered on a Windows desktop, most preferred first.
///
/// `pwsh` leads when PowerShell 7 was found among `candidates` (the paths from
/// [`windows_shell_candidates`]). `powershell` and `cmd` are always offered —
/// they ship with Windows, and saved connections that name them must keep
/// resolving (they are not migrated to `pwsh`). `gitbash` follows when a Git
/// Bash install was found.
pub fn windows_shell_kinds(candidates: &[String], has_git_bash: bool) -> Vec<String> {
    let mut kinds = Vec::new();
    if candidates.iter().any(|c| shell_kind(c) == "pwsh") {
        kinds.push("pwsh".to_string());
    }
    kinds.push("powershell".to_string());
    kinds.push("cmd".to_string());
    if has_git_bash {
        kinds.push("gitbash".to_string());
    }
    kinds
}

/// Derive the shell *kind* from a shell setting.
///
/// Shell settings are either a bare kind (`"bash"`, `"pwsh"`, `"wsl:Ubuntu"`)
/// or an executable path (the agent stores `/bin/bash` or
/// `C:\Program Files\PowerShell\7\pwsh.exe`). Shell integration and startup
/// flags are keyed on the kind, so a path is reduced to its file stem — split
/// on both `/` and `\` (independent of the host), case-insensitive, `.exe`
/// stripped — and mapped to a known kind: `pwsh`, `powershell`, `cmd`,
/// `bash`, `zsh`, `sh`, `fish`, `nushell` (`nu`) or `gitbash`.
///
/// Values whose stem is not a known kind are returned unchanged, so unknown
/// shells and special values (`"ssh"`, `"wsl:<distro>"`, `"custom"`) keep
/// their existing meaning.
pub fn shell_kind(shell: &str) -> &str {
    let base = shell.rsplit(['/', '\\']).next().unwrap_or(shell);
    let lower = base.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    match stem {
        "zsh" => "zsh",
        "bash" => "bash",
        "sh" => "sh",
        "cmd" => "cmd",
        "powershell" => "powershell",
        "pwsh" => "pwsh",
        "gitbash" => "gitbash",
        "fish" => "fish",
        "nu" | "nushell" => "nushell",
        _ => shell,
    }
}

/// Live-environment wrapper around [`windows_shell_candidates`]: reads `PATH`
/// and `COMSPEC` from the process environment and probes the real filesystem.
pub fn detect_windows_shells() -> Vec<String> {
    let path_var = std::env::var_os("PATH");
    let comspec = std::env::var("COMSPEC").ok();
    windows_shell_candidates(
        |exe| find_in_path(exe, path_var.as_deref(), Path::is_file),
        comspec.as_deref(),
        Path::is_file,
    )
}

/// Live-environment wrapper around [`select_windows_default_shell`].
pub fn detect_windows_default_shell() -> String {
    let path_var = std::env::var_os("PATH");
    let comspec = std::env::var("COMSPEC").ok();
    select_windows_default_shell(
        |exe| find_in_path(exe, path_var.as_deref(), Path::is_file),
        comspec.as_deref(),
        Path::is_file,
    )
}

/// Extract the bare shell name from a `$SHELL` value (e.g. `/bin/zsh` -> `"zsh"`).
///
/// Split out of [`detect_default_shell`] so tests can exercise the parsing
/// without mutating the process-global `SHELL`, which concurrently running
/// local-shell PTY tests read to pick the shell they spawn (#3419).
#[cfg(unix)]
fn shell_name_from_env(shell_path: Option<&str>) -> Option<String> {
    Path::new(shell_path?)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

/// Resolve a shell name to the executable path and arguments.
///
/// Handles platform-specific resolution:
/// - WSL distros (`wsl:Ubuntu`, `wsl:Debian`)
/// - Git Bash on Windows (bare `bash` redirects to Git Bash to avoid WSL interception)
/// - PowerShell absolute path on Windows
/// - PowerShell 7 (`pwsh`), resolved via `PATH` on Windows
/// - Standard Unix shells (`zsh`, `bash`, `sh`)
/// - Executable paths, launched literally; a `pwsh`/`powershell` path also
///   gets `-NoLogo` (#3728)
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
        "pwsh" => resolve_pwsh(),
        "gitbash" => resolve_git_bash(),
        "fish" => ("fish".into(), vec!["--login".into()]),
        "nushell" => ("nu".into(), vec!["--login".into()]),
        other => {
            // If the value looks like a file path, use it as a literal executable.
            // This supports custom shell paths (e.g. "/opt/myshell/bin/mysh").
            // Otherwise, pass through the name as-is so any shell in PATH works
            // instead of silently falling back to sh.
            if other.contains('/') || other.contains('\\') {
                let args = if matches!(shell_kind(other), "pwsh" | "powershell") {
                    vec!["-NoLogo".into()]
                } else {
                    vec![]
                };
                (other.to_string(), args)
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
/// - On Unix, adds a UTF-8 locale when neither the inherited environment nor
///   `config.env` provides one (see [`utf8_locale_overrides`]). An app
///   launched from Finder/Dock gets no `LANG` from a login shell, so without
///   this the shell would run in the C locale (#4336).
pub fn build_shell_command(config: &ShellConfig) -> ShellCommand {
    if cfg!(windows) {
        // Windows shells do not use POSIX locale variables.
        build_shell_command_with(config, |_| None, "")
    } else {
        build_shell_command_with(
            config,
            |key| std::env::var(key).ok(),
            preferred_utf8_locale(),
        )
    }
}

/// The POSIX locale variables that decide the character encoding, most
/// specific first.
const LOCALE_KEYS: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];

/// Fallback UTF-8 locale when the system locale cannot be determined or is
/// not installed.
const FALLBACK_UTF8_LOCALE: &str = "en_US.UTF-8";

/// Compute the locale variables to add to a local shell's environment.
///
/// `config_env` is the connection's own env settings, `parent` looks up a
/// variable in the environment the child would inherit, and `utf8_locale` is
/// the UTF-8 locale to inject (e.g. `de_DE.UTF-8`).
///
/// Rules (an explicitly set locale is never overridden):
/// - any of `LC_ALL` / `LC_CTYPE` / `LANG` in `config_env` → nothing;
/// - inherited `LC_ALL` or `LC_CTYPE` set → nothing;
/// - inherited `LANG` unset → `LANG=<utf8_locale>`;
/// - inherited `LANG` is the non-UTF-8 `C` / `POSIX` locale →
///   `LC_CTYPE=<utf8_locale>` (only the encoding is upgraded; messages,
///   collation etc. keep following `LANG`);
/// - otherwise → nothing.
///
/// Empty values count as unset, matching libc's `setlocale` behaviour.
pub fn utf8_locale_overrides(
    config_env: &HashMap<String, String>,
    parent: impl Fn(&str) -> Option<String>,
    utf8_locale: &str,
) -> Vec<(String, String)> {
    let is_set = |v: Option<&str>| v.is_some_and(|v| !v.is_empty());

    if utf8_locale.is_empty()
        || LOCALE_KEYS
            .iter()
            .any(|k| is_set(config_env.get(*k).map(String::as_str)))
    {
        return Vec::new();
    }
    if is_set(parent("LC_ALL").as_deref()) || is_set(parent("LC_CTYPE").as_deref()) {
        return Vec::new();
    }
    match parent("LANG").filter(|v| !v.is_empty()) {
        None => vec![("LANG".to_string(), utf8_locale.to_string())],
        Some(lang) if lang == "C" || lang == "POSIX" => {
            vec![("LC_CTYPE".to_string(), utf8_locale.to_string())]
        }
        Some(_) => Vec::new(),
    }
}

/// Whether a locale name selects UTF-8 encoding (`xx_YY.UTF-8`, `C.utf8`,
/// macOS's bare `UTF-8`, ...).
pub fn is_utf8_locale(locale: &str) -> bool {
    let lower = locale.to_ascii_lowercase();
    lower.contains("utf-8") || lower.contains("utf8")
}

/// Normalize a BCP 47 / POSIX-ish locale tag (`de-DE`, `zh-Hans-CN`,
/// `en_US@rg=...`) to a POSIX UTF-8 locale name (`de_DE.UTF-8`).
///
/// Returns `None` when the tag has no two-letter region, since a bare
/// language such as `en` does not name an installable locale.
pub fn posix_utf8_locale_from_tag(tag: &str) -> Option<String> {
    let tag = tag.split(['@', '.']).next().unwrap_or_default();
    let mut parts = tag.split(['-', '_']);
    let language = parts.next()?;
    if !(2..=3).contains(&language.len()) || !language.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    // Subtags after a singleton (`u`, `x`, ...) are extensions, not a region.
    let region = parts
        .take_while(|p| p.len() > 1)
        .find(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic()))?;
    Some(format!(
        "{}_{}.UTF-8",
        language.to_ascii_lowercase(),
        region.to_ascii_uppercase()
    ))
}

/// The UTF-8 locale to give local shells that inherit none, computed once.
///
/// On macOS this follows the user's preferred locale (System Settings →
/// Language & Region, via CoreFoundation), normalized to `xx_YY.UTF-8` and
/// checked against the installed locales in `/usr/share/locale`, like
/// WezTerm's `set_lang_from_locale`. Elsewhere, and whenever that fails, it is
/// `en_US.UTF-8`.
pub fn preferred_utf8_locale() -> &'static str {
    static LOCALE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LOCALE.get_or_init(|| system_utf8_locale().unwrap_or_else(|| FALLBACK_UTF8_LOCALE.to_string()))
}

#[cfg(target_os = "macos")]
fn system_utf8_locale() -> Option<String> {
    sys_locale::get_locales()
        .filter_map(|tag| posix_utf8_locale_from_tag(&tag))
        .find(|locale| Path::new("/usr/share/locale").join(locale).is_dir())
}

#[cfg(not(target_os = "macos"))]
fn system_utf8_locale() -> Option<String> {
    None
}

/// [`build_shell_command`] with the inherited environment and the UTF-8
/// locale injected, so the locale defaulting is testable without mutating the
/// process environment.
fn build_shell_command_with(
    config: &ShellConfig,
    parent: impl Fn(&str) -> Option<String>,
    utf8_locale: &str,
) -> ShellCommand {
    let shell = config
        .shell
        .clone()
        .or_else(detect_default_shell)
        .unwrap_or_else(|| "sh".to_string());

    let (program, args) = shell_to_command(&shell);

    let mut env = config.env.clone();
    env.insert("TERM".to_string(), "xterm-256color".to_string());
    env.insert("COLORTERM".to_string(), "truecolor".to_string());
    for (key, value) in utf8_locale_overrides(&config.env, parent, utf8_locale) {
        env.insert(key, value);
    }

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

/// Return a shell command that enables CWD tracking and OSC 133 command marks
/// for the given shell.
///
/// POSIX-compatible shells use **OSC 7** (`file://` URI), which is the
/// cross-platform standard emitted natively by zsh and injected via
/// `PROMPT_COMMAND` / `precmd_functions` for bash variants.
///
/// PowerShell also uses **OSC 7** so the file browser's CWD-following works on
/// the default Windows shell (issue #2676): the snippet converts backslashes to
/// slashes, URL-encodes the path, and uses the hostname as the authority.
/// `cmd.exe` cannot cleanly build a URL-encoded file:// URI in its `PROMPT`
/// syntax, so it stays on **OSC 9;9** (Windows Terminal standard), which
/// carries the raw Windows path with no URL encoding or slash conversion.
///
/// - `"wsl:<distro>"` — OSC 7, WSL variant: `cd $HOME` guard for `/mnt/`
///   paths; injected visibly via the WSL temp-file source mechanism.
/// - `"ssh"` — OSC 7, SSH variant: no `/mnt/` guard; injected visibly via
///   stdin.
/// - `"bash"` / `"gitbash"` / `"zsh"` — OSC 7; uses `if [ -n "$ZSH_VERSION" ]`
///   to route zsh to `precmd_functions` and bash to `PROMPT_COMMAND`;
///   injected visibly via stdin.
/// - `"powershell"` / `"pwsh"` — OSC 7: overrides the `prompt` function to
///   emit a `file://` URI (both `powershell.exe` and `pwsh`); injected via
///   `-NoExit -Command` startup args (not stdin) to avoid echo.
/// - `"cmd"` — OSC 9;9: sets the `PROMPT` variable via `/K` startup arg
///   (not stdin) to avoid echo.
/// - `"fish"` — OSC 133 only (fish emits OSC 7 natively): registers
///   `fish_prompt` / `fish_preexec` / `fish_postexec` event handlers;
///   injected visibly via stdin.
/// - Anything else (`"sh"`, etc.) — `None`.
///
/// An executable path (`/bin/bash`, `C:\...\pwsh.exe`) is first reduced to its
/// kind via [`shell_kind`], so path-valued shells get the same integration as
/// their bare names (#3728).
///
/// Every variant (except cmd, which can only mark prompts) also emits
/// **OSC 133** semantic-prompt marks (`A` prompt start, `B` input start,
/// `C` output start, `D;<exit>` command finished) that drive prompt
/// navigation, command-output selection and the exit-status gutter in the
/// terminal (issue #3415, PROD-059).
pub fn osc7_setup_command(shell_type: &str) -> Option<&'static str> {
    let shell_type = shell_kind(shell_type);
    if shell_type.starts_with("wsl:") {
        Some(wsl_osc7_command())
    } else if matches!(shell_type, "ssh" | "bash" | "gitbash" | "zsh") {
        Some(bash_osc7_command())
    } else if matches!(shell_type, "powershell" | "pwsh") {
        Some(powershell_osc7_command())
    } else if shell_type == "cmd" {
        Some(cmd_osc9_command())
    } else if shell_type == "fish" {
        Some(fish_shell_integration_command())
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
    // No console window from the GUI-subsystem app (#3814).
    let output = crate::util::no_window::no_window_command("wsl.exe")
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
/// On Windows, includes PowerShell 7 (`pwsh`, first when installed), Windows
/// PowerShell, cmd, and Git Bash (see [`windows_shell_kinds`]).
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
            ("/usr/local/bin/pwsh", "pwsh"),
            ("/usr/bin/pwsh", "pwsh"),
            ("/snap/bin/pwsh", "pwsh"),
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
        // Git Bash is checked across every known install location (registry,
        // user-scope, PATH, scoop, Program Files) — shares the same resolver
        // as launch, so what we offer is exactly what we launch.
        shells.extend(windows_shell_kinds(
            &detect_windows_shells(),
            resolve_git_bash_path().is_some(),
        ));
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

/// Shared bash/zsh fragment: define the termiHub prompt hooks and register
/// them. Spliced verbatim into both [`wsl_osc7_command`] and
/// [`bash_osc7_command`]. It is a `macro_rules!` rather than a `fn`/`const`
/// because both callers embed it in a `concat!`, which accepts only literals.
///
/// # What the hooks emit
///
/// - `__termihub_osc7` runs before every prompt. It first captures `$?` (the
///   exit status of the command that just finished), then emits
///   **OSC 133 `D;<exit>`** (command finished), **OSC 7** (CWD, used by the
///   file browser) and **OSC 133 `A`** (prompt start), and finally returns the
///   captured status so later prompt hooks and `$?`-aware prompts still see the
///   real value (issue #3415, PROD-059).
/// - **OSC 133 `C`** (command output starts) is emitted from bash's `PS0`
///   (printed after a command line is read, before it runs) and from a zsh
///   `preexec` hook.
/// - **OSC 133 `B`** (end of prompt / start of user input) is appended to
///   `PS1` once. It is best effort: a prompt framework that rebuilds `PS1`
///   on every prompt simply drops it, and the frontend treats `B` as optional.
///
/// The frontend tolerates duplicate or missing marks (a `D` with no command
/// in flight — the first prompt, an empty Enter — is ignored), so emitting `D`
/// unconditionally before each prompt is safe.
///
/// # Ordering and idempotency
///
/// The hook must run **first** so it sees the finished command's `$?`, so it is
/// *prepended* to `PROMPT_COMMAND` / `precmd_functions` rather than appended.
/// Registration is guarded by the shell-local `__termihub_si` flag so running
/// the snippet twice never installs duplicate hooks or `PS0`/`PS1` marks.
///
/// The `if/else/fi` (not `&&…||`) isolates the zsh and bash paths: a non-zero
/// `precmd_functions=` must not fall through to set `PROMPT_COMMAND`, and in
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
/// so we probe the type via `declare -p` and prepend with
/// `PROMPT_COMMAND=(__termihub_osc7 "${PROMPT_COMMAND[@]}")` for arrays. bash
/// normalizes `declare -p` so array flags always begin `declare -a…` (even
/// `declare -xa` prints as `declare -ax`), making the `"declare -a"*` prefix
/// match exact — it never matches a scalar, including one whose value contains
/// the letter `a`.
macro_rules! osc7_bash_prompt_hook {
    () => {
        concat!(
            r#"__termihub_osc7(){ local __th_s=$?; "#,
            r#"printf '\e]133;D;%s\a' "$__th_s"; "#,
            r#"printf '\e]7;file://%s\a' "$PWD"; "#,
            r#"printf '\e]133;A\a'; "#,
            r#"return $__th_s; }; "#,
            r#"__termihub_osc133_c(){ printf '\e]133;C\a'; }; "#,
            r#"if [ -z "$__termihub_si" ]; then __termihub_si=1; "#,
            r#"if [ -n "$ZSH_VERSION" ]; then "#,
            r#"precmd_functions=(__termihub_osc7 $precmd_functions); "#,
            r#"preexec_functions+=(__termihub_osc133_c); "#,
            r#"PS1="$PS1"$'%{\e]133;B\a%}'; "#,
            r#"else "#,
            r#"case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in "#,
            r#""declare -a"*) PROMPT_COMMAND=(__termihub_osc7 "${PROMPT_COMMAND[@]}");; "#,
            r#"*) PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; "#,
            r#"esac; "#,
            r#"PS0="$PS0"'\e]133;C\a'; "#,
            r#"PS1="$PS1"'\[\e]133;B\a\]'; "#,
            r#"fi; "#,
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

/// Shell-integration setup command for PowerShell (both `powershell.exe` and
/// `pwsh`).
///
/// Overrides the built-in `prompt` function to emit an **OSC 7** CWD sequence
/// (`ESC ]7;file://<host>/<path> BEL`) before each prompt. OSC 7 is the
/// cross-platform standard the file browser follows for CWD-following; the
/// previous OSC 9;9 variant only drove the terminal's own CWD state, so
/// PowerShell users got no file-browser CWD-follow (issue #2676).
///
/// The snippet builds the file:// URI the way the frontend OSC 7 handler
/// expects: backslashes are converted to forward slashes (`C:\foo` ->
/// `C:/foo`), the path is URL-encoded via `[uri]::EscapeUriString` (so spaces
/// and other specials form a valid URI) and gets one leading `/` (`/C:/foo`,
/// while a Unix `/home/me` keeps its own — no `file:////home/me`), and
/// `$env:COMPUTERNAME` is the authority — or `[Environment]::MachineName`
/// where that is unset, as for `pwsh` on Linux/macOS (#4148), so the OSC 7
/// never has an empty host. Works identically for Windows PowerShell 5
/// (`powershell.exe`) and PowerShell 7 (`pwsh`) on any OS.
///
/// It also emits **OSC 133** command marks (issue #3415, PROD-059): `D;<exit>`
/// (derived from `$?` / `$LASTEXITCODE`, captured as the prompt's first
/// statement) and `A` before the prompt text, `B` appended after it, and `C`
/// from a `PSConsoleHostReadLine` wrapper (PSReadLine) once a command line has
/// been read. `$LASTEXITCODE` is restored so the user's prompt still sees it.
///
/// The user's existing `prompt` (from their profile, loaded before `-Command`
/// runs) is captured in `$__th_op` and invoked so the original prompt text is
/// preserved; a default `PS <path}> ` prompt is used only when none exists.
/// The whole setup is guarded by `$global:__th_si`, so running it twice cannot
/// capture termiHub's own `prompt` as the "original" and recurse.
/// Ends with `Clear-Host` to clear the screen. Injected via `-NoExit -Command`
/// startup args so the command never echoes.
fn powershell_osc7_command() -> &'static str {
    concat!(
        r#"if(-not $global:__th_si){$global:__th_si=1;"#,
        r#"$__th_op=$function:prompt;"#,
        r#"function prompt{"#,
        r#"$__th_ok=$?;$__th_ec=$global:LASTEXITCODE;"#,
        r#"$e=[char]27;$b=[char]7;"#,
        r#"$c=if($__th_ok){0}elseif($__th_ec){$__th_ec}else{1};"#,
        r#"$p=$PWD.Path;"#,
        r#"$u=[uri]::EscapeUriString(($p -replace '\\','/'));"#,
        r#"if(-not $u.StartsWith('/')){$u='/'+$u};"#,
        r#"$h=if($env:COMPUTERNAME){$env:COMPUTERNAME}else{[Environment]::MachineName};"#,
        r#"[Console]::Write($e+']133;D;'+$c+$b+$e+']7;file://'+$h+$u+$b+$e+']133;A'+$b);"#,
        r#"$t=if($__th_op){& $__th_op}else{'PS '+$p+'> '};"#,
        r#"$global:LASTEXITCODE=$__th_ec;"#,
        r#""$t"+$e+']133;B'+$b"#,
        r#"};"#,
        r#"if(Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue){"#,
        r#"$__th_rl=$function:PSConsoleHostReadLine;"#,
        r#"function PSConsoleHostReadLine{$l=& $__th_rl;[Console]::Write([char]27+']133;C'+[char]7);$l}"#,
        r#"}"#,
        r#"};Clear-Host"#,
    )
}

/// Shell-integration setup command for fish.
///
/// fish emits OSC 7 natively, so this only adds **OSC 133** command marks
/// (issue #3415, PROD-059) via fish's event system: `A` on `fish_prompt`,
/// `C` on `fish_preexec` and `D;<exit>` on `fish_postexec`. Nothing touches
/// the user's `fish_prompt` function. fish 4.0+ emits OSC 133 natively
/// (`A;click_events=1`, `B`, `C;cmdline_url=…`, `D;<exit>`), so the handlers
/// are only registered on fish 3.x (`$version` matching `^[0-3]\.`) —
/// duplicate marks would be harmless (the frontend collapses a repeated `A`
/// on the same line and ignores a `C`/`D` with no command in flight) but are
/// pointless. Guarded by the global `__termihub_si` so a second run cannot
/// register the handlers twice. Injected visibly via stdin.
fn fish_shell_integration_command() -> &'static str {
    concat!(
        r#"if not set -q __termihub_si; and string match -qr '^[0-3]\.' -- $version; "#,
        r#"set -g __termihub_si 1; "#,
        r#"echo '# [termiHub] Shell integration: setting up command marks'; "#,
        r#"function __termihub_osc133_a --on-event fish_prompt; printf '\e]133;A\a'; end; "#,
        r#"function __termihub_osc133_c --on-event fish_preexec; printf '\e]133;C\a'; end; "#,
        r#"function __termihub_osc133_d --on-event fish_postexec; printf '\e]133;D;%s\a' $status; end; "#,
        r#"end"#,
    )
}

/// OSC 9;9 setup command for cmd.exe.
///
/// Sets the `PROMPT` variable to embed an OSC 9;9 CWD sequence before each
/// prompt. In cmd's PROMPT syntax: `$E` expands to ESC (0x1B), `$P` to the
/// current drive and path (e.g. `C:\Users\foo`), `$G` to `>`, and `$E\`
/// forms the OSC String Terminator (`ESC \`). OSC 9;9 carries the raw Windows
/// path — no URL encoding or slash conversion needed. The prompt is also
/// bracketed by **OSC 133** `A` (prompt start) and `B` (input start) marks so
/// prompt navigation works (#3415); cmd has no pre/post-exec hook, so there is
/// no `C`/`D` and no exit-status decoration. Ends with `cls` to clear the
/// screen. Injected via `/K` startup arg so the command never echoes.
fn cmd_osc9_command() -> &'static str {
    r"PROMPT=$E]133;A$E\$E]9;9;$P$E\$P$G$E]133;B$E\ & cls"
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

/// Resolve PowerShell 7 (`pwsh`).
///
/// On Windows, looks `pwsh.exe` up on `PATH` for an absolute path (falling back
/// to the bare name); elsewhere uses `pwsh` from `PATH`.
fn resolve_pwsh() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let path_var = std::env::var_os("PATH");
        if let Some(path) = find_in_path("pwsh.exe", path_var.as_deref(), Path::is_file) {
            return (path.to_string_lossy().into_owned(), vec!["-NoLogo".into()]);
        }
        return ("pwsh.exe".into(), vec!["-NoLogo".into()]);
    }
    #[allow(unreachable_code)]
    ("pwsh".into(), vec!["-NoLogo".into()])
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
        // Exercise the `$SHELL` parsing on injected values rather than mutating
        // the process-global `SHELL`: local-shell PTY tests running in parallel
        // read it to choose the shell they spawn (#3419).
        assert_eq!(
            shell_name_from_env(Some("/usr/bin/fish")),
            Some("fish".to_string())
        );
        assert_eq!(shell_name_from_env(Some("zsh")), Some("zsh".to_string()));
        assert_eq!(shell_name_from_env(None), None);
        // And the real entry point agrees with the parser on the live value.
        assert_eq!(
            detect_default_shell(),
            shell_name_from_env(std::env::var("SHELL").ok().as_deref())
        );
    }

    /// The desktop default on Windows is the shared core selection (pwsh ->
    /// powershell -> cmd), reported as a shell *kind*, so desktop and agent
    /// agree (#3728).
    #[cfg(windows)]
    #[test]
    fn detect_default_shell_matches_shared_windows_selection() {
        let expected = shell_kind(&detect_windows_default_shell()).to_string();
        assert_eq!(detect_default_shell(), Some(expected.clone()));
        assert!(
            matches!(expected.as_str(), "pwsh" | "powershell" | "cmd"),
            "unexpected Windows default shell kind: {expected}"
        );
    }

    /// When PowerShell 7 is installed (it is on the GitHub Windows runners),
    /// the desktop must prefer it over Windows PowerShell (#3728).
    #[cfg(windows)]
    #[test]
    fn detect_default_shell_prefers_pwsh_when_on_path() {
        let path_var = std::env::var_os("PATH");
        if find_in_path("pwsh.exe", path_var.as_deref(), Path::is_file).is_some() {
            assert_eq!(detect_default_shell(), Some("pwsh".to_string()));
        }
    }

    // -----------------------------------------------------------------------
    // Windows shell selection (#3727) — platform-neutral, injected probes
    // -----------------------------------------------------------------------

    /// Build a `find_on_path` stub that resolves only the given executables.
    fn stub_path(found: &[(&'static str, &'static str)]) -> impl Fn(&str) -> Option<PathBuf> {
        let found = found.to_vec();
        move |exe| {
            found
                .iter()
                .find(|(name, _)| *name == exe)
                .map(|(_, path)| PathBuf::from(path))
        }
    }

    const PWSH: &str = r"C:\Program Files\PowerShell\7\pwsh.exe";
    const WINPS: &str = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    const CMD: &str = r"C:\Windows\system32\cmd.exe";

    #[test]
    fn windows_default_prefers_pwsh() {
        let pick = select_windows_default_shell(
            stub_path(&[("pwsh.exe", PWSH), ("powershell.exe", WINPS)]),
            Some(CMD),
            |_| true,
        );
        assert_eq!(pick, PWSH);
    }

    #[test]
    fn windows_default_falls_back_to_windows_powershell() {
        let pick = select_windows_default_shell(
            stub_path(&[("powershell.exe", WINPS)]),
            Some(CMD),
            |_| true,
        );
        assert_eq!(pick, WINPS);
    }

    #[test]
    fn windows_default_falls_back_to_comspec() {
        let pick = select_windows_default_shell(stub_path(&[]), Some(CMD), |_| true);
        assert_eq!(pick, CMD);
    }

    #[test]
    fn windows_default_ignores_missing_comspec_file() {
        let pick = select_windows_default_shell(stub_path(&[]), Some(CMD), |_| false);
        assert_eq!(pick, WINDOWS_FALLBACK_SHELL);
    }

    #[test]
    fn windows_default_last_resort_is_cmd_exe() {
        let pick = select_windows_default_shell(stub_path(&[]), None, |_| true);
        assert_eq!(pick, "cmd.exe");
        let pick = select_windows_default_shell(stub_path(&[]), Some("  "), |_| true);
        assert_eq!(pick, "cmd.exe");
    }

    #[test]
    fn windows_default_never_returns_unix_shell() {
        // The #3727 bug: a Windows agent defaulted to `/bin/sh`.
        for comspec in [None, Some(CMD)] {
            let pick = select_windows_default_shell(stub_path(&[]), comspec, |_| true);
            assert!(!pick.starts_with('/'), "unix path picked: {pick}");
        }
    }

    #[test]
    fn windows_candidates_lists_all_found_in_order() {
        let shells = windows_shell_candidates(
            stub_path(&[("powershell.exe", WINPS), ("pwsh.exe", PWSH)]),
            Some(CMD),
            |_| true,
        );
        assert_eq!(shells, vec![PWSH, WINPS, CMD]);
    }

    #[test]
    fn windows_candidates_empty_when_nothing_found() {
        let shells = windows_shell_candidates(stub_path(&[]), None, |_| true);
        assert!(shells.is_empty());
    }

    #[test]
    fn find_in_path_returns_first_matching_dir() {
        let path_var =
            std::env::join_paths(["/nope", "", "/first", "/second"].iter().map(PathBuf::from))
                .unwrap();
        let found = find_in_path("pwsh.exe", Some(&path_var), |p| {
            p.starts_with("/first") || p.starts_with("/second")
        });
        assert_eq!(found, Some(PathBuf::from("/first").join("pwsh.exe")));
    }

    #[test]
    fn find_in_path_none_without_path_or_match() {
        assert_eq!(find_in_path("pwsh.exe", None, |_| true), None);
        let path_var = std::env::join_paths([PathBuf::from("/a")]).unwrap();
        assert_eq!(find_in_path("pwsh.exe", Some(&path_var), |_| false), None);
    }

    #[test]
    fn find_in_path_real_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("pwsh.exe");
        std::fs::write(&exe, b"").unwrap();
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            find_in_path("pwsh.exe", Some(&path_var), Path::is_file),
            Some(exe)
        );
        assert_eq!(
            find_in_path("powershell.exe", Some(&path_var), Path::is_file),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn detect_windows_default_shell_is_a_windows_shell() {
        let pick = detect_windows_default_shell();
        let lower = pick.to_ascii_lowercase();
        assert!(
            lower.ends_with("pwsh.exe")
                || lower.ends_with("powershell.exe")
                || lower.ends_with("cmd.exe"),
            "unexpected Windows default shell: {pick}"
        );
        assert!(!pick.starts_with('/'));
        // Every reported shell exists on disk.
        for shell in detect_windows_shells() {
            assert!(Path::new(&shell).is_file(), "missing shell: {shell}");
        }
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

    // -----------------------------------------------------------------------
    // UTF-8 locale defaulting (#4336, I18N2-002)
    // -----------------------------------------------------------------------

    fn no_parent(_: &str) -> Option<String> {
        None
    }

    fn parent_with(
        vars: &'static [(&'static str, &'static str)],
    ) -> impl Fn(&str) -> Option<String> {
        move |key| {
            vars.iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn locale_empty_env_gets_utf8_lang() {
        let overrides = utf8_locale_overrides(&HashMap::new(), no_parent, "de_DE.UTF-8");
        assert_eq!(
            overrides,
            vec![("LANG".to_string(), "de_DE.UTF-8".to_string())]
        );
    }

    #[test]
    fn locale_empty_string_values_count_as_unset() {
        let overrides = utf8_locale_overrides(
            &HashMap::new(),
            parent_with(&[("LANG", ""), ("LC_ALL", ""), ("LC_CTYPE", "")]),
            "en_US.UTF-8",
        );
        assert_eq!(
            overrides,
            vec![("LANG".to_string(), "en_US.UTF-8".to_string())]
        );
    }

    #[test]
    fn locale_explicit_utf8_lang_is_kept() {
        let overrides = utf8_locale_overrides(
            &HashMap::new(),
            parent_with(&[("LANG", "de_DE.UTF-8")]),
            "en_US.UTF-8",
        );
        assert!(overrides.is_empty(), "got {overrides:?}");
    }

    #[test]
    fn locale_explicit_non_utf8_lang_is_kept() {
        let overrides = utf8_locale_overrides(
            &HashMap::new(),
            parent_with(&[("LANG", "de_DE.ISO8859-1")]),
            "en_US.UTF-8",
        );
        assert!(overrides.is_empty(), "got {overrides:?}");
    }

    #[test]
    fn locale_c_lang_gets_utf8_lc_ctype() {
        for c in ["C", "POSIX"] {
            let vars: &'static [(&'static str, &'static str)] = if c == "C" {
                &[("LANG", "C")]
            } else {
                &[("LANG", "POSIX")]
            };
            let overrides =
                utf8_locale_overrides(&HashMap::new(), parent_with(vars), "en_US.UTF-8");
            assert_eq!(
                overrides,
                vec![("LC_CTYPE".to_string(), "en_US.UTF-8".to_string())],
                "LANG={c}"
            );
        }
    }

    #[test]
    fn locale_explicit_lc_all_or_lc_ctype_is_kept() {
        for vars in [
            &[("LC_ALL", "C")][..],
            &[("LC_ALL", "fr_FR.UTF-8")][..],
            &[("LC_CTYPE", "UTF-8")][..],
            &[("LANG", "C"), ("LC_CTYPE", "C")][..],
        ] {
            let overrides =
                utf8_locale_overrides(&HashMap::new(), parent_with(vars), "en_US.UTF-8");
            assert!(overrides.is_empty(), "{vars:?} -> {overrides:?}");
        }
    }

    #[test]
    fn locale_connection_env_wins() {
        for key in ["LANG", "LC_ALL", "LC_CTYPE"] {
            let mut env = HashMap::new();
            env.insert(key.to_string(), "C".to_string());
            let overrides = utf8_locale_overrides(&env, no_parent, "en_US.UTF-8");
            assert!(overrides.is_empty(), "{key}=C -> {overrides:?}");
        }
        // A connection-level UTF-8 LANG also suppresses the C-locale fix-up
        // of an inherited LANG=C.
        let mut env = HashMap::new();
        env.insert("LANG".to_string(), "ja_JP.UTF-8".to_string());
        let overrides = utf8_locale_overrides(&env, parent_with(&[("LANG", "C")]), "en_US.UTF-8");
        assert!(overrides.is_empty(), "got {overrides:?}");
    }

    #[test]
    fn build_shell_command_injects_utf8_locale_into_empty_env() {
        let cmd = build_shell_command_with(&ShellConfig::default(), no_parent, "de_DE.UTF-8");
        assert_eq!(cmd.env.get("LANG").map(String::as_str), Some("de_DE.UTF-8"));
        assert!(!cmd.env.contains_key("LC_CTYPE"));
    }

    #[test]
    fn build_shell_command_connection_locale_wins() {
        let mut env = HashMap::new();
        env.insert("LANG".to_string(), "C".to_string());
        let config = ShellConfig {
            env,
            ..Default::default()
        };
        let cmd = build_shell_command_with(&config, no_parent, "de_DE.UTF-8");
        assert_eq!(cmd.env.get("LANG").map(String::as_str), Some("C"));
        assert!(!cmd.env.contains_key("LC_CTYPE"));
        assert!(!cmd.env.contains_key("LC_ALL"));
    }

    #[test]
    fn build_shell_command_c_parent_gets_lc_ctype() {
        let cmd = build_shell_command_with(
            &ShellConfig::default(),
            parent_with(&[("LANG", "C")]),
            "en_US.UTF-8",
        );
        assert!(
            !cmd.env.contains_key("LANG"),
            "inherited LANG must not be overridden"
        );
        assert_eq!(
            cmd.env.get("LC_CTYPE").map(String::as_str),
            Some("en_US.UTF-8")
        );
    }

    #[test]
    fn bcp47_tags_normalize_to_posix_utf8() {
        assert_eq!(
            posix_utf8_locale_from_tag("de-DE").as_deref(),
            Some("de_DE.UTF-8")
        );
        assert_eq!(
            posix_utf8_locale_from_tag("en_GB").as_deref(),
            Some("en_GB.UTF-8")
        );
        assert_eq!(
            posix_utf8_locale_from_tag("zh-Hans-CN").as_deref(),
            Some("zh_CN.UTF-8")
        );
        assert_eq!(
            posix_utf8_locale_from_tag("en-US-u-ca-gregory").as_deref(),
            Some("en_US.UTF-8")
        );
        assert_eq!(
            posix_utf8_locale_from_tag("fr-fr").as_deref(),
            Some("fr_FR.UTF-8")
        );
        assert_eq!(
            posix_utf8_locale_from_tag("en_US@rg=dezzzz").as_deref(),
            Some("en_US.UTF-8")
        );
        assert_eq!(posix_utf8_locale_from_tag("en"), None);
        assert_eq!(posix_utf8_locale_from_tag("es-419"), None);
        assert_eq!(posix_utf8_locale_from_tag(""), None);
        assert_eq!(posix_utf8_locale_from_tag("1x-DE"), None);
    }

    #[test]
    fn preferred_utf8_locale_is_utf8() {
        let locale = preferred_utf8_locale();
        assert!(is_utf8_locale(locale), "got {locale}");
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
    /// `PROMPT_COMMAND=(hook "${PROMPT_COMMAND[@]}")`. (ssh/gitbash/zsh share this command via the
    /// dispatch in [`osc7_setup_command`], covered by the *_contains_* tests.)
    #[test]
    fn osc7_bash_handles_array_prompt_command() {
        let setup = osc7_setup_command("bash").expect("expected Some for bash");
        assert!(
            setup.contains("declare -p PROMPT_COMMAND"),
            "must probe PROMPT_COMMAND type via declare -p, got: {setup}"
        );
        assert!(
            setup.contains(r#"PROMPT_COMMAND=(__termihub_osc7 "${PROMPT_COMMAND[@]}")"#),
            "must array-prepend the hook when PROMPT_COMMAND is an array, got: {setup}"
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
            setup.contains(r#"PROMPT_COMMAND=(__termihub_osc7 "${PROMPT_COMMAND[@]}")"#),
            "WSL: must array-prepend the hook when PROMPT_COMMAND is an array, got: {setup}"
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
    fn osc7_powershell_contains_expected_parts() {
        let setup = osc7_setup_command("powershell").expect("expected Some for powershell");
        // Must redefine the prompt function
        assert!(
            setup.contains("function prompt"),
            "expected prompt function override, got: {setup}"
        );
        // Must emit an OSC 7 file:// sequence (the cross-platform CWD standard
        // the file browser follows) — not the OSC 9;9 Windows-Terminal variant.
        assert!(
            setup.contains("]7;file://"),
            "expected OSC 7 file:// marker, got: {setup}"
        );
        assert!(
            !setup.contains("]9;9;"),
            "must not emit OSC 9;9 (file browser follows OSC 7), got: {setup}"
        );
        assert!(
            setup.contains("[char]27"),
            "expected ESC via [char]27, got: {setup}"
        );
        assert!(
            setup.contains("[char]7"),
            "expected BEL via [char]7, got: {setup}"
        );
        // Must convert Windows backslashes to forward slashes for the file:// URI.
        assert!(
            setup.contains(r#"-replace '\\','/'"#),
            "expected backslash->slash conversion for OSC 7, got: {setup}"
        );
        // Must URL-encode the path so spaces/specials form a valid URI.
        assert!(
            setup.contains("EscapeUriString"),
            "expected URL encoding via EscapeUriString, got: {setup}"
        );
        // Must use the real hostname as the file:// authority.
        assert!(
            setup.contains("COMPUTERNAME"),
            "expected hostname via $env:COMPUTERNAME, got: {setup}"
        );
        // Must clear screen at end
        assert!(
            setup.contains("Clear-Host"),
            "expected Clear-Host at end, got: {setup}"
        );
    }

    /// The dispatch in [`osc7_setup_command`] must be shell-aware: PowerShell
    /// receives the PowerShell `prompt`-function snippet (OSC 7 file:// URI),
    /// while bash/zsh receive the POSIX `PROMPT_COMMAND`/`precmd_functions`
    /// snippet — never the other way around. Sending bash syntax to PowerShell
    /// (or vice-versa) was the #2674 root cause.
    #[test]
    fn osc7_dispatch_is_shell_aware() {
        let ps = osc7_setup_command("powershell").expect("expected Some for powershell");
        let bash = osc7_setup_command("bash").expect("expected Some for bash");

        // PowerShell gets PowerShell syntax, not POSIX prompt-hook syntax.
        assert!(
            ps.contains("function prompt") && ps.contains("file://"),
            "powershell must get the PS OSC 7 snippet, got: {ps}"
        );
        assert!(
            !ps.contains("PROMPT_COMMAND") && !ps.contains("precmd_functions"),
            "powershell must NOT get POSIX bash/zsh syntax, got: {ps}"
        );

        // bash/zsh get POSIX syntax, not PowerShell syntax.
        assert!(
            bash.contains("__termihub_osc7") && bash.contains("PROMPT_COMMAND"),
            "bash must get the POSIX prompt-hook snippet, got: {bash}"
        );
        assert!(
            !bash.contains("function prompt") && !bash.contains("EscapeUriString"),
            "bash must NOT get PowerShell syntax, got: {bash}"
        );
    }

    // -----------------------------------------------------------------------
    // initial_command_strategy
    // -----------------------------------------------------------------------

    // -----------------------------------------------------------------------
    // OSC 133 command marks (#3415, PROD-059)
    // -----------------------------------------------------------------------

    /// Every POSIX variant (bash, zsh, gitbash, ssh, WSL) shares the same hook.
    const POSIX_SHELLS: &[&str] = &["bash", "zsh", "gitbash", "ssh", "wsl:Ubuntu"];

    #[test]
    fn osc133_posix_hook_emits_d_osc7_a_in_order_and_preserves_status() {
        for shell in POSIX_SHELLS {
            let setup = osc7_setup_command(shell).expect("expected Some");
            let status = setup
                .find("local __th_s=$?")
                .expect("must capture $? first");
            let d = setup.find(r"\e]133;D;%s\a").expect("must emit OSC 133 D");
            let osc7 = setup.find(r"\e]7;file://").expect("must emit OSC 7");
            let a = setup.find(r"\e]133;A\a").expect("must emit OSC 133 A");
            assert!(
                status < d && d < osc7 && osc7 < a,
                "{shell}: expected $? capture, then D, OSC 7, A: {setup}"
            );
            assert!(
                setup.contains(r#""$__th_s""#) && setup.contains("return $__th_s;"),
                "{shell}: D must carry the captured status and the hook must restore it: {setup}"
            );
        }
    }

    #[test]
    fn osc133_posix_hook_is_prepended_so_it_sees_the_real_exit_status() {
        for shell in POSIX_SHELLS {
            let setup = osc7_setup_command(shell).expect("expected Some");
            assert!(
                setup.contains("precmd_functions=(__termihub_osc7 $precmd_functions)"),
                "{shell}: zsh hook must be prepended: {setup}"
            );
            assert!(
                setup.contains(
                    r#"PROMPT_COMMAND="__termihub_osc7${PROMPT_COMMAND:+;$PROMPT_COMMAND}""#
                ),
                "{shell}: scalar PROMPT_COMMAND hook must be prepended: {setup}"
            );
        }
    }

    #[test]
    fn osc133_posix_emits_c_and_b_marks() {
        for shell in POSIX_SHELLS {
            let setup = osc7_setup_command(shell).expect("expected Some");
            // bash: C via PS0, B appended to PS1 inside \[ \] (zero-width).
            assert!(
                setup.contains(r#"PS0="$PS0"'\e]133;C\a'"#),
                "{shell}: bash must emit C via PS0: {setup}"
            );
            assert!(
                setup.contains(r#"PS1="$PS1"'\[\e]133;B\a\]'"#),
                "{shell}: bash must append a zero-width B mark to PS1: {setup}"
            );
            // zsh: C via preexec, B appended to PS1 inside %{ %} (zero-width).
            assert!(
                setup.contains("__termihub_osc133_c(){ printf '\\e]133;C\\a'; }")
                    && setup.contains("preexec_functions+=(__termihub_osc133_c)"),
                "{shell}: zsh must emit C from a preexec hook: {setup}"
            );
            assert!(
                setup.contains(r#"PS1="$PS1"$'%{\e]133;B\a%}'"#),
                "{shell}: zsh must append a zero-width B mark to PS1: {setup}"
            );
        }
    }

    /// Running the snippet twice must not register duplicate hooks or append
    /// the `PS0`/`PS1` marks twice: all registration sits behind one guard.
    #[test]
    fn osc133_posix_registration_is_idempotent() {
        for shell in POSIX_SHELLS {
            let setup = osc7_setup_command(shell).expect("expected Some");
            let guard = setup
                .find(r#"if [ -z "$__termihub_si" ]; then __termihub_si=1;"#)
                .expect("registration must be guarded");
            for registration in [
                "precmd_functions=",
                "preexec_functions+=",
                "PROMPT_COMMAND=",
                "PS0=",
                "PS1=",
            ] {
                let pos = setup
                    .find(registration)
                    .unwrap_or_else(|| panic!("{registration} missing"));
                assert!(
                    pos > guard,
                    "{shell}: {registration} must be inside the idempotency guard: {setup}"
                );
            }
        }
    }

    #[test]
    fn osc133_powershell_emits_all_marks_and_keeps_user_prompt() {
        let setup = osc7_setup_command("powershell").expect("expected Some for powershell");
        // $? must be captured as the prompt's very first statement.
        assert!(
            setup.contains("function prompt{$__th_ok=$?;$__th_ec=$global:LASTEXITCODE;"),
            "exit status must be captured first: {setup}"
        );
        assert!(
            setup.contains("$c=if($__th_ok){0}elseif($__th_ec){$__th_ec}else{1};"),
            "exit code must derive from $? / $LASTEXITCODE: {setup}"
        );
        assert!(
            setup.contains("']133;D;'+$c+$b"),
            "must emit D;<exit>: {setup}"
        );
        assert!(setup.contains("']133;A'+$b"), "must emit A: {setup}");
        assert!(
            setup.contains(r#""$t"+$e+']133;B'+$b"#),
            "must append B after the (user's) prompt text: {setup}"
        );
        assert!(
            setup.contains("& $__th_op") && setup.contains("$global:LASTEXITCODE=$__th_ec;"),
            "must run the original prompt and restore $LASTEXITCODE: {setup}"
        );
        assert!(
            setup.contains("function PSConsoleHostReadLine{") && setup.contains("']133;C'"),
            "must emit C from a PSConsoleHostReadLine wrapper: {setup}"
        );
        // Order within the pre-prompt write: D, then OSC 7, then A.
        let d = setup.find("]133;D;").unwrap();
        let osc7 = setup.find("]7;file://").unwrap();
        let a = setup.find("]133;A").unwrap();
        assert!(d < osc7 && osc7 < a, "expected D, OSC 7, A order: {setup}");
    }

    /// A second run must not capture termiHub's own `prompt` as the original
    /// (which would recurse forever): the whole setup sits behind a guard.
    #[test]
    fn osc133_powershell_setup_is_idempotent() {
        let setup = osc7_setup_command("powershell").expect("expected Some for powershell");
        assert!(
            setup.starts_with("if(-not $global:__th_si){$global:__th_si=1;"),
            "setup must be guarded: {setup}"
        );
        assert!(
            setup.ends_with("};Clear-Host"),
            "guard must close before Clear-Host: {setup}"
        );
    }

    #[test]
    fn osc133_cmd_marks_prompt_start_and_input_start() {
        let setup = osc7_setup_command("cmd").expect("expected Some for cmd");
        let a = setup.find(r"$E]133;A$E\").expect("must emit A");
        let cwd = setup.find("$E]9;9;").expect("must keep OSC 9;9");
        let b = setup.find(r"$E]133;B$E\").expect("must emit B");
        let prompt_text = setup.find("$P$G").expect("must keep the visible prompt");
        assert!(
            a < cwd && cwd < prompt_text && prompt_text < b,
            "expected A, OSC 9;9, prompt text, B: {setup}"
        );
    }

    #[test]
    fn osc133_fish_uses_events_and_is_idempotent() {
        let setup = osc7_setup_command("fish").expect("expected Some for fish");
        assert!(
            setup.contains("--on-event fish_prompt; printf '\\e]133;A\\a'; end"),
            "must emit A on fish_prompt: {setup}"
        );
        assert!(
            setup.contains("--on-event fish_preexec; printf '\\e]133;C\\a'; end"),
            "must emit C on fish_preexec: {setup}"
        );
        assert!(
            setup.contains("--on-event fish_postexec; printf '\\e]133;D;%s\\a' $status; end"),
            "must emit D;$status on fish_postexec: {setup}"
        );
        assert!(
            setup.starts_with("if not set -q __termihub_si; ")
                && setup.contains("set -g __termihub_si 1; ")
                && setup.ends_with("end"),
            "fish setup must be guarded: {setup}"
        );
        // fish 4.0+ emits OSC 133 natively — only register on fish 3.x.
        assert!(
            setup.contains(r"string match -qr '^[0-3]\.' -- $version"),
            "fish handlers must be limited to fish < 4: {setup}"
        );
        // fish syntax only — never POSIX / PowerShell hooks.
        assert!(
            !setup.contains("PROMPT_COMMAND") && !setup.contains("function prompt{"),
            "fish must not get bash/PowerShell syntax: {setup}"
        );
        // fish owns its prompt function; termiHub must not replace it.
        assert!(
            !setup.contains("function fish_prompt"),
            "must not override the user's fish_prompt: {setup}"
        );
    }

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

    // -----------------------------------------------------------------------
    // shell_kind (#3728)
    // -----------------------------------------------------------------------

    #[test]
    fn shell_kind_bare_names_pass_through() {
        for name in [
            "zsh",
            "bash",
            "sh",
            "cmd",
            "powershell",
            "pwsh",
            "gitbash",
            "fish",
            "nushell",
        ] {
            assert_eq!(shell_kind(name), name);
        }
    }

    #[test]
    fn shell_kind_keeps_non_path_values() {
        assert_eq!(shell_kind("wsl:Ubuntu"), "wsl:Ubuntu");
        assert_eq!(shell_kind("ssh"), "ssh");
        assert_eq!(shell_kind("elvish"), "elvish");
        assert_eq!(shell_kind("custom"), "custom");
    }

    #[test]
    fn shell_kind_from_unix_paths() {
        assert_eq!(shell_kind("/bin/bash"), "bash");
        assert_eq!(shell_kind("/usr/bin/zsh"), "zsh");
        assert_eq!(shell_kind("/usr/local/bin/fish"), "fish");
        assert_eq!(shell_kind("/bin/sh"), "sh");
        assert_eq!(shell_kind("/opt/homebrew/bin/nu"), "nushell");
        assert_eq!(shell_kind("/usr/local/bin/pwsh"), "pwsh");
    }

    #[test]
    fn shell_kind_from_windows_paths() {
        assert_eq!(shell_kind(PWSH), "pwsh");
        assert_eq!(shell_kind(WINPS), "powershell");
        assert_eq!(shell_kind(CMD), "cmd");
        assert_eq!(shell_kind(r"C:\Program Files\Git\bin\bash.exe"), "bash");
        assert_eq!(shell_kind(r"C:\tools\zsh.exe"), "zsh");
        assert_eq!(shell_kind(r"C:\tools\fish.exe"), "fish");
    }

    #[test]
    fn shell_kind_is_case_insensitive_and_strips_exe() {
        assert_eq!(shell_kind(r"C:\WINDOWS\System32\CMD.EXE"), "cmd");
        assert_eq!(
            shell_kind(r"C:\Program Files\PowerShell\7\PwSh.Exe"),
            "pwsh"
        );
        assert_eq!(shell_kind("PowerShell.exe"), "powershell");
        assert_eq!(shell_kind("cmd.exe"), "cmd");
        assert_eq!(shell_kind("pwsh.exe"), "pwsh");
        assert_eq!(shell_kind("C:/Program Files/PowerShell/7/pwsh.exe"), "pwsh");
    }

    #[test]
    fn shell_kind_unknown_path_is_left_unchanged() {
        assert_eq!(shell_kind("/opt/myshell/bin/mysh"), "/opt/myshell/bin/mysh");
        assert_eq!(
            shell_kind(r"C:\shells\myshell.exe"),
            r"C:\shells\myshell.exe"
        );
    }

    #[test]
    fn osc7_setup_command_supports_pwsh_and_paths() {
        let ps = osc7_setup_command("powershell");
        assert!(ps.is_some());
        assert_eq!(osc7_setup_command("pwsh"), ps);
        assert_eq!(osc7_setup_command(PWSH), ps);
        assert_eq!(osc7_setup_command(WINPS), ps);
        assert_eq!(osc7_setup_command(CMD), osc7_setup_command("cmd"));
        assert_eq!(osc7_setup_command("/bin/bash"), osc7_setup_command("bash"));
        assert!(osc7_setup_command("/bin/bash").is_some());
        assert_eq!(
            osc7_setup_command("/usr/bin/fish"),
            osc7_setup_command("fish")
        );
        assert_eq!(osc7_setup_command("/opt/myshell/bin/mysh"), None);
    }

    #[test]
    fn powershell_osc7_host_falls_back_and_path_gets_one_leading_slash() {
        let setup = powershell_osc7_command();
        // #4148: `$env:COMPUTERNAME` is unset on Linux/macOS, so the host falls
        // back to `[Environment]::MachineName`; Windows still uses COMPUTERNAME.
        assert!(setup.contains("$h=if($env:COMPUTERNAME){$env:COMPUTERNAME}"));
        assert!(setup.contains("[Environment]::MachineName"));
        // A Unix path keeps its own leading `/`; `C:/x` gets one (`/C:/x`).
        assert!(setup.contains("if(-not $u.StartsWith('/')){$u='/'+$u}"));
        assert!(setup.contains("']7;file://'+$h+$u+"));
        assert!(!setup.contains("+'/'+$u"), "no unconditional extra slash");
    }

    /// Run the PowerShell setup in a real `pwsh` (when one is installed) and
    /// check the OSC 7 its prompt prints: a non-empty host and exactly one
    /// slash before the path, on the OS the test runs on (#4148).
    #[test]
    fn powershell_osc7_prompt_is_well_formed_in_a_real_pwsh() {
        let Ok(out) = std::process::Command::new("pwsh")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
            .arg(format!(
                "{}; Set-Location ([System.IO.Path]::GetTempPath()); prompt",
                powershell_osc7_command()
            ))
            .output()
        else {
            eprintln!("SKIPPED: pwsh is not installed");
            return;
        };
        assert!(out.status.success(), "pwsh failed: {out:?}");
        let text = String::from_utf8_lossy(&out.stdout);
        let start = text.find("\x1b]7;file://").expect("an OSC 7") + "\x1b]7;file://".len();
        let end = start + text[start..].find('\x07').expect("BEL-terminated OSC 7");
        let rest = &text[start..end];
        let slash = rest.find('/').expect("a path after the host");
        assert!(slash > 0, "empty OSC 7 host: {rest:?}");
        let path = &rest[slash..];
        assert!(
            !path.starts_with("//"),
            "doubled slash before the path: {rest:?}"
        );
        if cfg!(windows) {
            assert!(
                path.as_bytes().get(2) == Some(&b':'),
                "/C:/... expected: {rest:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // pwsh shell kind + Windows default kind (#3728)
    // -----------------------------------------------------------------------

    #[test]
    fn shell_to_command_pwsh_has_nologo() {
        let (cmd, args) = shell_to_command("pwsh");
        assert_eq!(args, vec!["-NoLogo"]);
        #[cfg(unix)]
        assert_eq!(cmd, "pwsh");
        #[cfg(windows)]
        assert!(
            cmd.to_ascii_lowercase().ends_with("pwsh.exe"),
            "expected pwsh.exe, got: {cmd}"
        );
    }

    #[test]
    fn shell_to_command_powershell_paths_get_nologo() {
        let (cmd, args) = shell_to_command(PWSH);
        assert_eq!(cmd, PWSH);
        assert_eq!(args, vec!["-NoLogo"]);
        let (cmd, args) = shell_to_command(WINPS);
        assert_eq!(cmd, WINPS);
        assert_eq!(args, vec!["-NoLogo"]);
        // Other path-valued shells keep their literal, argument-free launch.
        let (cmd, args) = shell_to_command("/bin/bash");
        assert_eq!(cmd, "/bin/bash");
        assert!(args.is_empty());
    }

    #[test]
    fn windows_default_kind_prefers_pwsh() {
        let kind = windows_default_shell_kind(
            stub_path(&[("pwsh.exe", PWSH), ("powershell.exe", WINPS)]),
            Some(CMD),
            |_| true,
        );
        assert_eq!(kind, "pwsh");
    }

    #[test]
    fn windows_default_kind_falls_back_in_order() {
        let kind =
            windows_default_shell_kind(stub_path(&[("powershell.exe", WINPS)]), Some(CMD), |_| {
                true
            });
        assert_eq!(kind, "powershell");
        let kind = windows_default_shell_kind(stub_path(&[]), Some(CMD), |_| true);
        assert_eq!(kind, "cmd");
        let kind = windows_default_shell_kind(stub_path(&[]), None, |_| true);
        assert_eq!(kind, "cmd");
    }

    #[test]
    fn windows_shell_kinds_puts_pwsh_first_and_keeps_powershell_and_cmd() {
        let candidates = vec![PWSH.to_string(), WINPS.to_string(), CMD.to_string()];
        assert_eq!(
            windows_shell_kinds(&candidates, true),
            vec!["pwsh", "powershell", "cmd", "gitbash"]
        );
        // Without pwsh, saved "powershell"/"cmd" choices are still offered.
        assert_eq!(windows_shell_kinds(&[], false), vec!["powershell", "cmd"]);
        assert_eq!(
            windows_shell_kinds(&[PWSH.to_string()], false),
            vec!["pwsh", "powershell", "cmd"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn detect_available_shells_windows_order() {
        let shells = detect_available_shells();
        let path_var = std::env::var_os("PATH");
        let has_pwsh = find_in_path("pwsh.exe", path_var.as_deref(), Path::is_file).is_some();
        if has_pwsh {
            assert_eq!(
                shells.first().map(String::as_str),
                Some("pwsh"),
                "{shells:?}"
            );
        } else {
            assert!(!shells.contains(&"pwsh".to_string()), "{shells:?}");
        }
        assert!(shells.contains(&"cmd".to_string()), "{shells:?}");
        let default = detect_default_shell().expect("windows default shell");
        assert!(
            shells.contains(&default),
            "default {default} not in {shells:?}"
        );
    }
}
