//! State-machine tests for [`WorkflowRunStore`], proving the run authority
//! matches the frontend `appStore` reducers (#1852 / #1865) transition for
//! transition: runStarted → stepAdvanced → terminal outcome, the lazy output
//! panel and its status stamping, the stale-progress and stray-terminal guards,
//! dismissal, and the per-client isolation the client-scoped region requires.

use super::*;

const C: &str = "client-1";

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_fresh_client_is_empty() {
    let store = WorkflowRunStore::new();
    let view = store.snapshot(C);
    assert_eq!(view["run"], Value::Null);
    assert_eq!(view["output"], Value::Null);
}

#[test]
fn run_started_registers_the_run_at_zero_progress() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 3);
    assert_eq!(store.run_progress(C), Some((3, 0)));
    let view = store.snapshot(C);
    assert_eq!(view["run"]["workflowId"], json!("wf-1"));
    assert_eq!(view["run"]["workflowName"], json!("Deploy"));
    assert_eq!(view["run"]["tabId"], json!("tab-9"));
    assert_eq!(view["run"]["total"], json!(3));
    assert_eq!(view["run"]["completed"], json!(0));
    assert_eq!(view["output"], Value::Null);
}

#[test]
fn step_advanced_updates_progress_for_the_matching_run() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 3);
    store.step_advanced(C, "wf-1", "tab-9", 1);
    assert_eq!(store.run_progress(C), Some((3, 1)));
    store.step_advanced(C, "wf-1", "tab-9", 2);
    assert_eq!(store.snapshot(C)["run"]["completed"], json!(2));
}

#[test]
fn step_advanced_from_a_stale_run_is_ignored() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 3);
    // A newer run replaced the first; progress from the old workflow/tab must
    // not clobber it (mirrors appStore's onProgress workflowId/tabId guard).
    store.run_started(C, "wf-2", "Backup", "tab-4", 2);
    store.step_advanced(C, "wf-1", "tab-9", 3); // stale workflow id
    store.step_advanced(C, "wf-2", "tab-9", 1); // stale tab id
    assert_eq!(store.run_progress(C), Some((2, 0)), "progress unchanged");
    store.step_advanced(C, "wf-2", "tab-4", 1); // matches → applies
    assert_eq!(store.run_progress(C), Some((2, 1)));
}

#[test]
fn step_advanced_with_no_active_run_is_a_no_op() {
    let store = WorkflowRunStore::new();
    store.step_advanced(C, "wf-1", "tab-9", 1);
    assert_eq!(store.run_progress(C), None);
    assert_eq!(store.snapshot(C)["run"], Value::Null);
}

#[test]
fn run_started_clears_a_prior_runs_output_panel() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 1);
    store.output_opened(C, "wf-1", "Deploy", "echo", &ids(&["hi"]));
    store.run_completed(C);
    assert_eq!(store.snapshot(C)["output"]["status"], json!("completed"));

    // A fresh run nulls the leftover panel (recreated only if it spawns one).
    store.run_started(C, "wf-2", "Backup", "tab-4", 1);
    assert_eq!(store.snapshot(C)["output"], Value::Null);
}

#[test]
fn output_opened_starts_the_panel_running() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 2);
    store.output_opened(C, "wf-1", "Deploy", "make", &ids(&["build", "-j4"]));
    let view = store.snapshot(C);
    assert_eq!(view["output"]["workflowId"], json!("wf-1"));
    assert_eq!(view["output"]["workflowName"], json!("Deploy"));
    assert_eq!(view["output"]["program"], json!("make"));
    assert_eq!(view["output"]["args"], json!(["build", "-j4"]));
    assert_eq!(view["output"]["status"], json!("running"));
    assert_eq!(view["output"]["error"], Value::Null);
}

#[test]
fn a_second_local_process_takes_over_the_panel() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 2);
    store.output_opened(C, "wf-1", "Deploy", "make", &ids(&["build"]));
    store.output_opened(C, "wf-1", "Deploy", "curl", &ids(&["https://x"]));
    let view = store.snapshot(C);
    assert_eq!(view["output"]["program"], json!("curl"));
    assert_eq!(view["output"]["args"], json!(["https://x"]));
    assert_eq!(view["output"]["status"], json!("running"));
}

#[test]
fn run_completed_clears_the_run_and_stamps_the_panel() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 2);
    store.output_opened(C, "wf-1", "Deploy", "echo", &ids(&["done"]));
    store.step_advanced(C, "wf-1", "tab-9", 2);
    store.run_completed(C);

    let view = store.snapshot(C);
    assert_eq!(view["run"], Value::Null, "run cleared on settle");
    assert_eq!(store.run_progress(C), None);
    assert_eq!(view["output"]["status"], json!("completed"));
    assert_eq!(view["output"]["error"], Value::Null);
}

#[test]
fn run_cancelled_clears_the_run_and_stamps_the_panel() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 3);
    store.output_opened(C, "wf-1", "Deploy", "sleep", &ids(&["100"]));
    store.run_cancelled(C);

    let view = store.snapshot(C);
    assert_eq!(view["run"], Value::Null);
    assert_eq!(view["output"]["status"], json!("cancelled"));
    assert_eq!(view["output"]["error"], Value::Null);
}

#[test]
fn run_failed_stamps_status_and_error_on_the_panel() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 3);
    store.output_opened(C, "wf-1", "Deploy", "make", &ids(&["build"]));
    store.run_failed(C, Some("exit code 1".to_string()));

    let view = store.snapshot(C);
    assert_eq!(view["run"], Value::Null);
    assert_eq!(view["output"]["status"], json!("failed"));
    assert_eq!(view["output"]["error"], json!("exit code 1"));
}

#[test]
fn a_terminal_native_run_settles_with_no_output_panel() {
    // A run that never spawns a local process has no output panel; settling it
    // clears the run and leaves output null (appStore leaves it untouched).
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 2);
    store.step_advanced(C, "wf-1", "tab-9", 2);
    store.run_completed(C);

    let view = store.snapshot(C);
    assert_eq!(view["run"], Value::Null);
    assert_eq!(view["output"], Value::Null);
}

#[test]
fn a_terminal_intent_with_no_active_run_leaves_the_panel_untouched() {
    // A stray terminal intent after the run already settled must not re-stamp a
    // dismissed-or-settled panel (mirrors appStore's `activeWorkflowRun ===
    // handle` guard: only the current run clears/stamps).
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 1);
    store.output_opened(C, "wf-1", "Deploy", "echo", &ids(&["hi"]));
    store.run_completed(C);
    assert_eq!(store.snapshot(C)["output"]["status"], json!("completed"));

    // No active run now — a stray failed intent is a no-op on the panel.
    store.run_failed(C, Some("late".to_string()));
    let view = store.snapshot(C);
    assert_eq!(
        view["output"]["status"],
        json!("completed"),
        "not restamped"
    );
    assert_eq!(view["output"]["error"], Value::Null);
}

#[test]
fn dismiss_output_clears_the_panel_only() {
    let store = WorkflowRunStore::new();
    store.run_started(C, "wf-1", "Deploy", "tab-9", 1);
    store.output_opened(C, "wf-1", "Deploy", "echo", &ids(&["hi"]));
    store.run_completed(C);
    store.dismiss_output(C);
    assert_eq!(store.snapshot(C)["output"], Value::Null);
}

#[test]
fn dismiss_output_with_no_panel_is_a_no_op() {
    let store = WorkflowRunStore::new();
    store.dismiss_output(C);
    assert_eq!(store.snapshot(C)["output"], Value::Null);
}

#[test]
fn output_opened_with_no_args_projects_an_empty_array() {
    let store = WorkflowRunStore::new();
    store.output_opened(C, "wf-1", "Deploy", "ls", &[]);
    assert_eq!(store.snapshot(C)["output"]["args"], json!([]));
}

#[test]
fn runs_are_isolated_per_client() {
    let store = WorkflowRunStore::new();
    store.run_started("a", "wf-a", "A", "tab-a", 2);
    store.run_started("b", "wf-b", "B", "tab-b", 3);

    store.step_advanced("a", "wf-a", "tab-a", 1);
    // Client b is untouched by client a's progress.
    assert_eq!(store.run_progress("b"), Some((3, 0)));
    store.run_failed("b", Some("boom".to_string()));

    assert_eq!(store.run_progress("a"), Some((2, 1)));
    assert_eq!(store.snapshot("a")["run"]["completed"], json!(1));
    assert_eq!(store.snapshot("b")["run"], Value::Null, "b settled");
}
