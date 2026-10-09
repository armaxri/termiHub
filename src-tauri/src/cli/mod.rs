//! Pre-init CLI handling for the print-and-exit flags `--version`, `--help`
//! (#2655) and `--list-workspaces` (#3854).
//!
//! These flags must print and exit **before** any Tauri window, spawn IPC, or
//! bridge setup runs, so they work headlessly with no display. They must also
//! run before the single-instance plugin registers: that plugin exits a second
//! process during plugin setup, so a flag handled later (in `setup()`) prints
//! nothing while an instance is already running (#3854). They are classified
//! from the raw process arguments in [`crate::run`], mirroring
//! [`crate::spawn::classify_command`], and dispatched via [`handle_info_flag`].

use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::utils::migrate::{load_versioned, salvage_input, LoadOutcome, Salvage, VersionedStore};
use crate::workspace::config::{WorkspaceStore, WorkspaceSummary};

#[cfg(test)]
mod tests;

/// A top-level informational flag recognised before application init.
#[derive(Debug, PartialEq, Eq)]
pub enum InfoFlag {
    /// `--version` / `-V` — print the version and exit 0.
    Version,
    /// `--help` / `-h` — print a usage summary and exit 0.
    Help,
    /// `--list-workspaces` — print the saved workspaces and exit (#3854).
    ListWorkspaces,
}

/// Classify the process arguments (with the program name already stripped) into
/// an optional [`InfoFlag`]. Pure and side-effect-free so it is unit-testable.
///
/// `--version` / `--help` are recognised only as the **first** argument, so
/// subcommand-scoped flags such as `spawn --help` are left for the subcommand
/// and a normal launch (or a bare `--workspace foo`) is never mistaken for an
/// info request.
///
/// `--list-workspaces` is a top-level option that `tauri_plugin_cli` accepts in
/// any position, so it is recognised anywhere — unless the first argument is a
/// subcommand (anything not starting with `-`), which owns its own arguments.
pub fn classify_info_flag(args: &[String]) -> Option<InfoFlag> {
    let first = args.first().map(String::as_str)?;
    match first {
        "--version" | "-V" => Some(InfoFlag::Version),
        "--help" | "-h" => Some(InfoFlag::Help),
        _ if first.starts_with('-') && args.iter().any(|a| a == "--list-workspaces") => {
            Some(InfoFlag::ListWorkspaces)
        }
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

/// Read the saved workspaces from `config_dir` **without writing anything**.
///
/// Unlike the running app's `WorkspaceStorage::load_with_recovery`, this never
/// migrates, backs up, or resets the file: a listing may run alongside a live
/// instance that owns the store, so it must stay strictly read-only. A missing
/// file means no workspaces; individually-corrupt entries are skipped in memory
/// (as the app's salvage would); a newer-schema or unreadable file is an error.
pub fn load_workspace_summaries(config_dir: &Path) -> Result<Vec<WorkspaceSummary>> {
    let path = config_dir.join("workspaces.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    match load_versioned::<WorkspaceStore>(&raw) {
        LoadOutcome::Loaded { data, .. } => {
            Ok(data.workspaces.iter().map(|ws| ws.to_summary()).collect())
        }
        LoadOutcome::Newer(err) => bail!("{err}"),
        LoadOutcome::Corrupt(err) => {
            let salvaged = salvage_input::<WorkspaceStore>(&raw)
                .map(|value| WorkspaceStore::salvage(value, "workspaces.json"));
            match salvaged {
                Some(Salvage::Recovered { data, .. }) => {
                    Ok(data.workspaces.iter().map(|ws| ws.to_summary()).collect())
                }
                _ => bail!("{} is unreadable: {err}", path.display()),
            }
        }
    }
}

/// Format the `--list-workspaces` output: one tab-separated line per workspace
/// (`id`, `name`, `N tab(s)`, `description`), or a notice when there are none.
pub fn format_workspace_list(workspaces: &[WorkspaceSummary]) -> String {
    if workspaces.is_empty() {
        return "No workspaces configured.".to_string();
    }
    workspaces
        .iter()
        .map(|ws| {
            format!(
                "{}\t{}\t{} tab(s)\t{}",
                ws.id,
                ws.name,
                ws.connection_count,
                ws.description.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Print the saved workspaces from the pre-init config directory (which honours
/// `TERMIHUB_CONFIG_DIR` and portable mode) and return the exit status.
fn list_workspaces() -> i32 {
    let result = crate::utils::config_paths::resolve_config_dir(None)
        .and_then(|dir| load_workspace_summaries(&dir));
    match result {
        Ok(workspaces) => {
            println!("{}", format_workspace_list(&workspaces));
            0
        }
        Err(e) => {
            eprintln!("Error listing workspaces: {e:#}");
            1
        }
    }
}

/// Print the output for `flag` and exit the process. Never returns. Kept out of
/// [`classify_info_flag`] so the classification stays pure and testable.
pub fn handle_info_flag(flag: InfoFlag) -> ! {
    let code = match flag {
        InfoFlag::Version => {
            println!("{}", version_line());
            0
        }
        InfoFlag::Help => {
            println!("{}", help_text());
            0
        }
        InfoFlag::ListWorkspaces => list_workspaces(),
    };
    std::process::exit(code)
}
