use super::{
    classify_info_flag, format_workspace_list, help_text, load_workspace_summaries, version_line,
    InfoFlag,
};
use crate::workspace::config::WorkspaceSummary;
use tempfile::TempDir;

fn to_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

#[test]
fn classify_version_long_and_short() {
    assert_eq!(
        classify_info_flag(&to_args(&["--version"])),
        Some(InfoFlag::Version)
    );
    assert_eq!(
        classify_info_flag(&to_args(&["-V"])),
        Some(InfoFlag::Version)
    );
}

#[test]
fn classify_help_long_and_short() {
    assert_eq!(
        classify_info_flag(&to_args(&["--help"])),
        Some(InfoFlag::Help)
    );
    assert_eq!(classify_info_flag(&to_args(&["-h"])), Some(InfoFlag::Help));
}

#[test]
fn classify_non_info_args_is_none() {
    // No args → normal launch.
    assert_eq!(classify_info_flag(&[]), None);
    // Known launch flags must not be captured as info flags.
    assert_eq!(classify_info_flag(&to_args(&["--workspace", "w"])), None);
    // Subcommands own their own flags (`spawn --help` is spawn's help).
    assert_eq!(classify_info_flag(&to_args(&["spawn", "--help"])), None);
    assert_eq!(
        classify_info_flag(&to_args(&["install-shell-integration"])),
        None
    );
}

#[test]
fn classify_only_inspects_first_arg() {
    // A trailing `--version` after a launch flag is not a top-level info request.
    assert_eq!(
        classify_info_flag(&to_args(&["--workspace", "--version"])),
        None
    );
}

#[test]
fn version_line_reports_crate_version() {
    let line = version_line();
    assert!(
        line.contains(env!("CARGO_PKG_VERSION")),
        "version line {line:?} should contain the crate version"
    );
}

#[test]
fn help_text_lists_real_flags_and_commands() {
    let help = help_text();
    for token in [
        "--version",
        "--help",
        "--list-workspaces",
        "--workspace",
        "spawn",
    ] {
        assert!(
            help.contains(token),
            "help text should mention {token:?}, got:\n{help}"
        );
    }
}

#[test]
fn classify_list_workspaces_in_any_top_level_position() {
    assert_eq!(
        classify_info_flag(&to_args(&["--list-workspaces"])),
        Some(InfoFlag::ListWorkspaces)
    );
    assert_eq!(
        classify_info_flag(&to_args(&["--workspace", "w", "--list-workspaces"])),
        Some(InfoFlag::ListWorkspaces)
    );
    // `--version` / `--help` as the first argument still win.
    assert_eq!(
        classify_info_flag(&to_args(&["--help", "--list-workspaces"])),
        Some(InfoFlag::Help)
    );
}

#[test]
fn classify_list_workspaces_ignored_after_subcommand() {
    // A subcommand owns its own arguments.
    assert_eq!(
        classify_info_flag(&to_args(&["spawn", "--list-workspaces"])),
        None
    );
    assert_eq!(classify_info_flag(&to_args(&["--workspace", "w"])), None);
}

fn summary(id: &str, name: &str, tabs: usize, desc: Option<&str>) -> WorkspaceSummary {
    WorkspaceSummary {
        id: id.to_string(),
        name: name.to_string(),
        description: desc.map(str::to_string),
        connection_count: tabs,
        group_count: None,
    }
}

#[test]
fn format_workspace_list_empty_and_populated() {
    assert_eq!(format_workspace_list(&[]), "No workspaces configured.");
    let out = format_workspace_list(&[
        summary("ws-1", "Work", 3, Some("daily")),
        summary("ws-2", "Home", 0, None),
    ]);
    assert_eq!(out, "ws-1\tWork\t3 tab(s)\tdaily\nws-2\tHome\t0 tab(s)\t");
}

#[test]
fn load_workspace_summaries_missing_file_is_empty() {
    let dir = TempDir::new().unwrap();
    assert!(load_workspace_summaries(dir.path()).unwrap().is_empty());
    assert!(
        !dir.path().join("workspaces.json").exists(),
        "listing must not create the store"
    );
}

#[test]
fn load_workspace_summaries_reads_store_without_writing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("workspaces.json");
    // A v1 file: the app would migrate and rewrite it; the listing must not.
    let raw = r#"{"version":"1","workspaces":[{"id":"ws-1","name":"Work","tabGroups":[]}]}"#;
    std::fs::write(&path, raw).unwrap();

    let list = load_workspace_summaries(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, "ws-1");
    assert_eq!(list[0].name, "Work");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        raw,
        "file untouched"
    );
}

#[test]
fn load_workspace_summaries_skips_corrupt_entries_without_writing() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("workspaces.json");
    let raw = r#"{"version":"2","workspaces":[{"id":"ws-1","name":"Work","tabGroups":[]},"bad"]}"#;
    std::fs::write(&path, raw).unwrap();

    let list = load_workspace_summaries(dir.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        raw,
        "file untouched"
    );
    assert!(!dir.path().join("workspaces.json.bak").exists());
}

#[test]
fn load_workspace_summaries_errors_on_newer_or_garbage_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("workspaces.json");
    std::fs::write(&path, r#"{"version":"99","workspaces":[]}"#).unwrap();
    assert!(load_workspace_summaries(dir.path()).is_err());

    std::fs::write(&path, "not json").unwrap();
    assert!(load_workspace_summaries(dir.path()).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
}
