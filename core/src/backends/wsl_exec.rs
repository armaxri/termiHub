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

/// POSIX `sh` program that prints the symlink target of every positional path,
/// each terminated by a NUL byte (#1523, #4008).
///
/// Used by the WSL file browser because Windows cannot read a WSL symlink's
/// target over the `\\wsl$` share: the link surfaces as a reparse point that
/// `std::fs::read_link` does not understand. A path whose target cannot be read
/// prints an empty record, so the output always has one record per path, in
/// order. NUL separation keeps names and targets containing spaces or newlines
/// intact; only `readlink` (coreutils and busybox) is required.
pub(crate) const READLINK_TARGETS_SH: &str =
    "for p; do printf '%s\\0' \"$(readlink -- \"$p\")\"; done";

/// Most paths resolved by one `wsl.exe` spawn, keeping the command line well
/// under the Windows 32 767-character limit.
pub(crate) const READLINK_BATCH: usize = 128;

/// Build the `wsl.exe` argument vector that prints the symlink targets of
/// `paths` inside `distribution` (see [`READLINK_TARGETS_SH`]).
pub(crate) fn readlink_targets_args(distribution: &str, paths: &[&str]) -> Vec<String> {
    distro_sh_args(distribution, READLINK_TARGETS_SH, paths)
}

/// Split [`READLINK_TARGETS_SH`] output into exactly `count` targets, in order.
/// Empty records and records missing from truncated output are `None`.
pub(crate) fn parse_readlink_targets(stdout: &[u8], count: usize) -> Vec<Option<String>> {
    let mut targets: Vec<Option<String>> = stdout
        .split(|b| *b == 0)
        .take(count)
        .map(|t| (!t.is_empty()).then(|| String::from_utf8_lossy(t).into_owned()))
        .collect();
    targets.resize(count, None);
    targets
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

    #[test]
    fn readlink_args_pass_paths_positionally() {
        let args = readlink_targets_args("Debian", &["/tmp/a link", "/tmp/$(id)"]);
        assert_eq!(args[5], READLINK_TARGETS_SH);
        assert_eq!(&args[6..], ["sh", "/tmp/a link", "/tmp/$(id)"]);
    }

    #[test]
    fn parse_readlink_targets_keeps_order_and_maps_empty_to_none() {
        let out = b"real.txt\0\0/etc\0";
        assert_eq!(
            parse_readlink_targets(out, 3),
            vec![Some("real.txt".to_string()), None, Some("/etc".to_string())]
        );
    }

    #[test]
    fn parse_readlink_targets_pads_truncated_output() {
        assert_eq!(
            parse_readlink_targets(b"a\0", 3),
            vec![Some("a".to_string()), None, None]
        );
        assert_eq!(parse_readlink_targets(b"", 2), vec![None, None]);
    }

    /// Run the readlink program with a real `sh` over real symlinks: file,
    /// directory and dangling links resolve, a regular file and a missing
    /// path yield `None`, and names with spaces or newlines survive.
    #[cfg(unix)]
    #[test]
    fn readlink_program_resolves_real_symlinks_in_order() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("tempdir");
        let d = dir.path();
        std::fs::write(d.join("real.txt"), b"x").expect("write");
        std::fs::create_dir(d.join("realdir")).expect("mkdir");
        symlink("real.txt", d.join("link.txt")).expect("link");
        symlink("realdir", d.join("link dir")).expect("link");
        symlink("does-not-exist", d.join("dangling")).expect("link");
        symlink("odd\ntarget", d.join("odd\nname")).expect("link");
        let names = [
            "link.txt",
            "real.txt",
            "link dir",
            "dangling",
            "missing",
            "odd\nname",
        ];
        let paths: Vec<String> = names
            .iter()
            .map(|n| d.join(n).to_string_lossy().into_owned())
            .collect();
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        let args = readlink_targets_args("Debian", &refs);
        let exec = args.iter().position(|a| a == "--exec").expect("--exec");
        let out = std::process::Command::new(&args[exec + 1])
            .args(&args[exec + 2..])
            .output()
            .expect("run sh");
        assert_eq!(
            parse_readlink_targets(&out.stdout, names.len()),
            vec![
                Some("real.txt".to_string()),
                None,
                Some("realdir".to_string()),
                Some("does-not-exist".to_string()),
                None,
                Some("odd\ntarget".to_string()),
            ]
        );
    }

    #[test]
    fn a_full_readlink_batch_fits_the_windows_command_line() {
        let path = format!("/home/user/{}", "d".repeat(190));
        let paths = vec![path.as_str(); READLINK_BATCH];
        // Each argument costs its length plus quotes and a separator.
        let line: usize = readlink_targets_args("Ubuntu-24.04", &paths)
            .iter()
            .map(|a| a.len() + 3)
            .sum::<usize>()
            + "wsl.exe ".len();
        assert!(line < 32_767, "command line of {line} chars is too long");
    }
}
