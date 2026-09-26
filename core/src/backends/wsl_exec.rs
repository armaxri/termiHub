//! Platform-independent helpers for the short-lived helper `wsl.exe` spawns of
//! the WSL backend (monitoring, process manager, distro-side init-script
//! create) (#3313, follow-up to #2837).
//!
//! The WSL backend itself is Windows-only; the argument building lives here as
//! pure functions so it is unit-tested on every platform:
//!
//! - [`CREATE_NO_WINDOW`] — the Windows process-creation flag every helper
//!   `wsl.exe` spawn sets, so a console child of the GUI-subsystem termiHub
//!   process never flashes a console window.
//! - [`distro_sh_args`] — `-d <distro> --exec sh -c <program> [sh <args>…]`.
//!   `--exec` runs `sh` directly instead of handing a re-joined command line to
//!   the distribution's default login shell (what `--` does), so the program
//!   reaches `sh -c` byte-for-byte: no outer word splitting, quote removal or
//!   `$` / backtick expansion by a second shell.

/// Windows `CREATE_NO_WINDOW` process-creation flag. Every helper `wsl.exe`
/// spawn sets it so no console window flashes (the same class of bug fixed for
/// the RDP sidecar).
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build the `wsl.exe` argument vector that runs `program` with `sh -c` inside
/// `distribution`.
///
/// With `positional` empty the result is `-d <distro> --exec sh -c <program>`.
/// Otherwise `sh` is appended as `$0` followed by `positional` as `$1…`, so
/// variable data is passed as arguments and never spliced into the program.
pub(crate) fn distro_sh_args(
    distribution: &str,
    program: &str,
    positional: &[&str],
) -> Vec<String> {
    let mut args: Vec<String> = ["-d", distribution, "--exec", "sh", "-c", program]
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    if !positional.is_empty() {
        args.push("sh".to_string());
        args.extend(positional.iter().map(|s| (*s).to_string()));
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitoring::{build_kill_command, KillSignal, MONITORING_COMMAND};

    #[test]
    fn create_no_window_is_the_win32_flag() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn monitoring_args_use_exec_and_pass_program_verbatim() {
        let args = distro_sh_args("Ubuntu-22.04", MONITORING_COMMAND, &[]);
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu-22.04",
                "--exec",
                "sh",
                "-c",
                MONITORING_COMMAND
            ]
        );
        // `--` would hand a re-joined line to the login shell; never emit it.
        assert!(!args.iter().any(|a| a == "--"));
    }

    #[test]
    fn process_command_is_one_argument_even_with_shell_metacharacters() {
        let kill = build_kill_command(4242, KillSignal::Term);
        let hostile = "echo \"$HOME\" `id`; echo 'a b'";
        for program in [kill.as_str(), hostile] {
            let args = distro_sh_args("Debian", program, &[]);
            assert_eq!(args.len(), 6);
            assert_eq!(args[5], program, "program must reach sh -c unchanged");
        }
    }

    #[test]
    fn positional_args_follow_a_dollar_zero_placeholder() {
        let args = distro_sh_args("Ubuntu", "cat > \"$1\"", &["/tmp/x"]);
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--exec",
                "sh",
                "-c",
                "cat > \"$1\"",
                "sh",
                "/tmp/x"
            ]
        );
    }

    /// Run the argv `wsl.exe --exec` would hand to the distro (everything after
    /// `--exec`) with a real `sh`, proving the program's quoting and `$`
    /// references are interpreted by exactly one shell.
    #[cfg(unix)]
    #[test]
    fn exec_argv_runs_program_through_exactly_one_shell() {
        let program = "x='a  b'; printf '%s|%s|%s' \"$x\" \"$0\" \"$1\"";
        let args = distro_sh_args("Ubuntu", program, &["it's $HOME"]);
        let exec = args.iter().position(|a| a == "--exec").expect("--exec");
        let argv = &args[exec + 1..];
        let out = std::process::Command::new(&argv[0])
            .args(&argv[1..])
            .output()
            .expect("run sh");
        assert_eq!(String::from_utf8_lossy(&out.stdout), "a  b|sh|it's $HOME");
    }
}
