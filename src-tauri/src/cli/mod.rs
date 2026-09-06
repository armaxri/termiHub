//! Pre-init CLI handling for the top-level informational flags `--version` and
//! `--help` (#2655).
//!
//! These flags must print and exit **before** any Tauri window, spawn IPC, or
//! bridge setup runs, so they work headlessly with no display. They are
//! classified from the raw process arguments in [`crate::run`], mirroring
//! [`crate::spawn::classify_command`], and dispatched via [`handle_info_flag`].

#[cfg(test)]
mod tests;

/// A top-level informational flag recognised before application init.
#[derive(Debug, PartialEq, Eq)]
pub enum InfoFlag {
    /// `--version` / `-V` — print the version and exit 0.
    Version,
    /// `--help` / `-h` — print a usage summary and exit 0.
    Help,
}

/// Classify the process arguments (with the program name already stripped) into
/// an optional [`InfoFlag`]. Pure and side-effect-free so it is unit-testable.
///
/// Only the **first** argument is inspected, so subcommand-scoped flags such as
/// `spawn --help` are left for the subcommand and a normal launch (or a bare
/// `--workspace foo`) is never mistaken for an info request.
pub fn classify_info_flag(args: &[String]) -> Option<InfoFlag> {
    match args.first().map(String::as_str) {
        Some("--version" | "-V") => Some(InfoFlag::Version),
        Some("--help" | "-h") => Some(InfoFlag::Help),
        _ => None,
    }
}

/// The single line printed by `--version`. Uses the same
/// `env!("CARGO_PKG_VERSION")` that the startup log line records, so the CLI and
/// the log agree on the version.
pub fn version_line() -> String {
    format!("termiHub {}", env!("CARGO_PKG_VERSION"))
}

/// The usage summary printed by `--help`. Lists only the flags and subcommands
/// the binary actually honors (declared in `tauri.conf.json`'s `cli.args` and in
/// [`crate::spawn::classify_command`]).
pub fn help_text() -> String {
    format!(
        "\
{version}
termiHub — cross-platform terminal hub

Usage:
  termihub [OPTIONS]
  termihub <COMMAND> [ARGS]

Options:
  -w, --workspace <NAME>       Launch a workspace by name
      --workspace-file <FILE>  Launch a workspace from a JSON definition file
      --list-workspaces        List all saved workspaces and exit
  -V, --version                Print version information and exit
  -h, --help                   Print this help and exit

Commands:
  spawn                        Open a session in the running instance (see `spawn --help`)
  install-shell-integration    Register the OS shell/context-menu integration
  uninstall-shell-integration  Remove the OS shell/context-menu integration

Run with no arguments to launch the desktop application.",
        version = version_line()
    )
}

/// Print the output for `flag` and exit the process with status 0. Never
/// returns. Kept out of [`classify_info_flag`] so the classification stays pure
/// and testable.
pub fn handle_info_flag(flag: InfoFlag) -> ! {
    match flag {
        InfoFlag::Version => println!("{}", version_line()),
        InfoFlag::Help => println!("{}", help_text()),
    }
    std::process::exit(0)
}
