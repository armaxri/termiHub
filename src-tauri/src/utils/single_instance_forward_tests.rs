//! Tests for second-launch argument forwarding (#3101): the pure argv parser,
//! the workspace-request resolution, and the handler that emits the request to
//! the running instance's frontend.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Listener, Runtime};

use super::*;
use crate::utils::errors::TerminalError;

fn argv(args: &[&str]) -> Vec<String> {
    // The plugin hands over the full argv, program name first.
    std::iter::once("termihub")
        .chain(args.iter().copied())
        .map(str::to_string)
        .collect()
}

fn cwd() -> PathBuf {
    std::env::temp_dir().join("second-launch-cwd")
}

fn parse(args: &[&str]) -> ForwardedArgs {
    parse_forwarded_args(&argv(args), &cwd())
}

// ---- parse_forwarded_args ----------------------------------------------------

#[test]
fn bare_relaunch_carries_no_request() {
    assert_eq!(parse(&[]), ForwardedArgs::default());
}

#[test]
fn program_name_is_never_treated_as_an_argument() {
    // argv[0] must be skipped even when it looks like a positional argument.
    let parsed = parse_forwarded_args(&["/opt/termihub/termihub".to_string()], &cwd());
    assert_eq!(parsed, ForwardedArgs::default());
}

#[test]
fn long_workspace_flag_with_separate_value() {
    assert_eq!(
        parse(&["--workspace", "Dev"]).workspace,
        Some(WorkspaceRequest::Name("Dev".to_string()))
    );
}

#[test]
fn long_workspace_flag_with_equals_value() {
    assert_eq!(
        parse(&["--workspace=Dev Box"]).workspace,
        Some(WorkspaceRequest::Name("Dev Box".to_string()))
    );
}

#[test]
fn short_workspace_flag_with_separate_value() {
    assert_eq!(
        parse(&["-w", "Dev"]).workspace,
        Some(WorkspaceRequest::Name("Dev".to_string()))
    );
}

#[test]
fn short_workspace_flag_with_attached_value() {
    assert_eq!(
        parse(&["-wDev"]).workspace,
        Some(WorkspaceRequest::Name("Dev".to_string()))
    );
}

#[test]
fn relative_workspace_file_resolves_against_second_launch_cwd() {
    assert_eq!(
        parse(&["--workspace-file", "ws.json"]).workspace,
        Some(WorkspaceRequest::File(cwd().join("ws.json")))
    );
}

#[test]
fn absolute_workspace_file_is_kept_as_is() {
    let abs = std::env::temp_dir().join("abs-ws.json");
    let arg = format!("--workspace-file={}", abs.display());
    let parsed = parse_forwarded_args(&argv(&[arg.as_str()]), &cwd());
    assert_eq!(parsed.workspace, Some(WorkspaceRequest::File(abs)));
    assert!(parsed.ignored.is_empty());
}

#[test]
fn workspace_name_takes_precedence_over_file_like_at_startup() {
    // `get_cli_workspace` checks `--workspace` before `--workspace-file`; the
    // forwarded path must agree, and the losing flag is reported as ignored.
    let parsed = parse(&["--workspace-file", "ws.json", "--workspace", "Dev"]);
    assert_eq!(
        parsed.workspace,
        Some(WorkspaceRequest::Name("Dev".to_string()))
    );
    assert_eq!(parsed.ignored, vec!["--workspace-file ws.json".to_string()]);
}

#[test]
fn workspace_flag_without_value_is_ignored() {
    let parsed = parse(&["--workspace"]);
    assert_eq!(parsed.workspace, None);
    assert_eq!(parsed.ignored, vec!["--workspace".to_string()]);
}

#[test]
fn workspace_flag_followed_by_another_flag_has_no_value() {
    let parsed = parse(&["-w", "--frobnicate"]);
    assert_eq!(parsed.workspace, None);
    assert_eq!(
        parsed.ignored,
        vec!["-w".to_string(), "--frobnicate".to_string()]
    );
}

#[test]
fn empty_workspace_name_is_ignored() {
    let parsed = parse(&["--workspace="]);
    assert_eq!(parsed.workspace, None);
    assert_eq!(parsed.ignored, vec!["--workspace=".to_string()]);
}

#[test]
fn unknown_flags_and_positionals_are_ignored_and_reported() {
    let parsed = parse(&["--frobnicate", "some-file.txt", "-x"]);
    assert_eq!(parsed.workspace, None);
    assert_eq!(
        parsed.ignored,
        vec![
            "--frobnicate".to_string(),
            "some-file.txt".to_string(),
            "-x".to_string()
        ]
    );
}

#[test]
fn list_workspaces_is_not_forwardable() {
    // It prints to the *second* process's stdout and exits; the running
    // instance has nothing to act on, so it is reported as ignored.
    let parsed = parse(&["--list-workspaces"]);
    assert_eq!(parsed.workspace, None);
    assert_eq!(parsed.ignored, vec!["--list-workspaces".to_string()]);
}

#[test]
fn unknown_args_do_not_prevent_a_valid_workspace_request() {
    let parsed = parse(&["--frobnicate", "-w", "Dev"]);
    assert_eq!(
        parsed.workspace,
        Some(WorkspaceRequest::Name("Dev".to_string()))
    );
    assert_eq!(parsed.ignored, vec!["--frobnicate".to_string()]);
}

// ---- resolve_workspace_request -----------------------------------------------

#[test]
fn name_request_resolves_without_touching_the_file_loader() {
    let resolved = resolve_workspace_request(
        WorkspaceRequest::Name("Dev".to_string()),
        |_: &Path| -> Result<String, TerminalError> { panic!("loader must not run") },
    );
    assert_eq!(resolved, Some("Dev".to_string()));
}

#[test]
fn file_request_resolves_to_the_saved_workspace_name() {
    let seen = Mutex::new(None);
    let resolved = resolve_workspace_request(
        WorkspaceRequest::File(PathBuf::from("/tmp/ws.json")),
        |p: &Path| {
            *seen.lock().unwrap() = Some(p.to_path_buf());
            Ok("Imported".to_string())
        },
    );
    assert_eq!(resolved, Some("Imported".to_string()));
    assert_eq!(
        seen.into_inner().unwrap(),
        Some(PathBuf::from("/tmp/ws.json"))
    );
}

#[test]
fn unreadable_workspace_file_resolves_to_nothing() {
    let resolved = resolve_workspace_request(
        WorkspaceRequest::File(PathBuf::from("/nope/ws.json")),
        |_: &Path| Err(TerminalError::WorkspaceError("cannot read".to_string())),
    );
    assert_eq!(resolved, None);
}

// ---- handle_forwarded_args (the running instance's receiver) -----------------

fn record<R: Runtime>(app: &AppHandle<R>, event: &str) -> Arc<Mutex<Vec<serde_json::Value>>> {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = seen.clone();
    app.listen_any(event, move |e| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(e.payload()).unwrap());
    });
    seen
}

#[test]
fn forwarded_workspace_is_emitted_to_the_running_frontend() {
    let app = tauri::test::mock_app();
    let seen = record(app.handle(), CLI_WORKSPACE_REQUESTED_EVENT);

    let outcome = handle_forwarded_args(app.handle(), &argv(&["--workspace", "Dev"]), &cwd());

    assert_eq!(outcome, Some("Dev".to_string()));
    assert_eq!(*seen.lock().unwrap(), vec![serde_json::json!("Dev")]);
}

#[test]
fn bare_relaunch_emits_nothing() {
    let app = tauri::test::mock_app();
    let seen = record(app.handle(), CLI_WORKSPACE_REQUESTED_EVENT);

    let outcome = handle_forwarded_args(app.handle(), &argv(&[]), &cwd());

    assert_eq!(outcome, None);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn only_unknown_args_emit_nothing() {
    let app = tauri::test::mock_app();
    let seen = record(app.handle(), CLI_WORKSPACE_REQUESTED_EVENT);

    let outcome = handle_forwarded_args(app.handle(), &argv(&["--bogus", "x"]), &cwd());

    assert_eq!(outcome, None);
    assert!(seen.lock().unwrap().is_empty());
}

#[test]
fn workspace_file_without_a_workspace_manager_emits_nothing() {
    // The file path needs the WorkspaceManager to persist the definition; when
    // it is not (yet) managed the request is dropped, never panicking.
    let app = tauri::test::mock_app();
    let seen = record(app.handle(), CLI_WORKSPACE_REQUESTED_EVENT);

    let outcome = handle_forwarded_args(
        app.handle(),
        &argv(&["--workspace-file", "ws.json"]),
        &cwd(),
    );

    assert_eq!(outcome, None);
    assert!(seen.lock().unwrap().is_empty());
}
