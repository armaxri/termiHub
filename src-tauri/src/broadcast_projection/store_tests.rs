//! State-machine tests for [`BroadcastStore`], proving the membership authority
//! matches the frontend `appStore` broadcast reducers (#1955 / #1956 / #1958)
//! transition for transition: start → add/remove → stop, the source-in-set and
//! de-dup rules, the scope/lastScope retention across a stop, the toggle
//! decision, and the per-client isolation the client-scoped region requires.

use super::*;

const C: &str = "client-1";

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_fresh_client_is_the_idle_baseline() {
    let store = BroadcastStore::new();
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(false));
    assert_eq!(view["sourceTabId"], Value::Null);
    assert_eq!(view["scope"], json!("all"));
    assert_eq!(view["targetTabIds"], json!([]));
    assert_eq!(view["lastScope"], json!("all"));
}

#[test]
fn start_activates_with_the_source_first_in_the_target_set() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::All, "src", &ids(&["t1", "t2"]));
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(true));
    assert_eq!(view["sourceTabId"], json!("src"));
    assert_eq!(view["scope"], json!("all"));
    assert_eq!(view["lastScope"], json!("all"));
    // Source first, then the resolved targets — mirrors `new Set([source, ...])`.
    assert_eq!(view["targetTabIds"], json!(["src", "t1", "t2"]));
}

#[test]
fn start_dedups_a_source_that_reappears_in_the_targets() {
    let store = BroadcastStore::new();
    // resolveBroadcastTargetTabIds returns every terminal in the group including
    // the source, so the source commonly appears again in `targetTabIds`.
    store.start(
        C,
        BroadcastScope::Panel,
        "src",
        &ids(&["t1", "src", "t2", "t1"]),
    );
    assert_eq!(
        store.snapshot(C)["targetTabIds"],
        json!(["src", "t1", "t2"])
    );
    assert_eq!(store.snapshot(C)["scope"], json!("panel"));
}

#[test]
fn start_records_scope_as_both_active_and_remembered() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::Custom, "src", &ids(&["t1"]));
    let view = store.snapshot(C);
    assert_eq!(view["scope"], json!("custom"));
    assert_eq!(view["lastScope"], json!("custom"));
}

#[test]
fn stop_clears_source_and_targets_but_retains_scope() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::Panel, "src", &ids(&["t1", "t2"]));
    store.stop(C);
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(false));
    assert_eq!(view["sourceTabId"], Value::Null);
    assert_eq!(view["targetTabIds"], json!([]));
    // stopBroadcast deliberately leaves scope/lastScope for the toggle (#1958).
    assert_eq!(view["scope"], json!("panel"));
    assert_eq!(view["lastScope"], json!("panel"));
}

#[test]
fn add_target_appends_when_absent_and_is_a_no_op_when_present() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::All, "src", &ids(&["t1"]));
    store.add_target(C, "t2");
    assert_eq!(
        store.snapshot(C)["targetTabIds"],
        json!(["src", "t1", "t2"])
    );
    // Adding an existing target changes nothing.
    store.add_target(C, "t1");
    assert_eq!(
        store.snapshot(C)["targetTabIds"],
        json!(["src", "t1", "t2"])
    );
}

#[test]
fn remove_target_deletes_when_present_and_is_a_no_op_when_absent() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::All, "src", &ids(&["t1", "t2"]));
    store.remove_target(C, "t1");
    assert_eq!(store.snapshot(C)["targetTabIds"], json!(["src", "t2"]));
    // Removing an absent target changes nothing.
    store.remove_target(C, "ghost");
    assert_eq!(store.snapshot(C)["targetTabIds"], json!(["src", "t2"]));
}

#[test]
fn toggle_while_active_stops() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::Panel, "src", &ids(&["t1"]));
    // Payload is ignored on the stop branch.
    store.toggle(C, BroadcastScope::All, Some("other"), &ids(&["x"]));
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(false));
    assert_eq!(view["sourceTabId"], Value::Null);
    assert_eq!(view["targetTabIds"], json!([]));
    // Scope retained from the start (stop does not reset it).
    assert_eq!(view["scope"], json!("panel"));
}

#[test]
fn toggle_while_idle_with_a_source_starts() {
    let store = BroadcastStore::new();
    store.toggle(C, BroadcastScope::All, Some("src"), &ids(&["t1"]));
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(true));
    assert_eq!(view["sourceTabId"], json!("src"));
    assert_eq!(view["targetTabIds"], json!(["src", "t1"]));
}

#[test]
fn toggle_while_idle_without_a_source_is_a_no_op() {
    let store = BroadcastStore::new();
    // Mirrors the frontend "focus a terminal" guard: nothing to broadcast from.
    store.toggle(C, BroadcastScope::All, None, &[]);
    assert_eq!(store.snapshot(C)["active"], json!(false));
    assert_eq!(store.status(C).map(|(a, _, _)| a), Some(false));
}

#[test]
fn start_supersedes_a_prior_session() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::All, "src1", &ids(&["t1", "t2"]));
    store.start(C, BroadcastScope::Custom, "src2", &ids(&["t3"]));
    let view = store.snapshot(C);
    assert_eq!(view["sourceTabId"], json!("src2"));
    assert_eq!(view["scope"], json!("custom"));
    assert_eq!(view["targetTabIds"], json!(["src2", "t3"]));
}

#[test]
fn status_and_targets_helpers_reflect_state() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::Panel, "src", &ids(&["t1"]));
    assert_eq!(
        store.status(C),
        Some((true, Some("src".to_string()), BroadcastScope::Panel))
    );
    assert_eq!(store.target_tab_ids(C), ids(&["src", "t1"]));
}

#[test]
fn replace_overwrites_the_whole_slice_verbatim() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::All, "src", &ids(&["t1"]));
    // The render-cut mirror sets every field verbatim — no source-prepend/de-dup,
    // because the appStore set it mirrors is already canonical.
    store.replace(
        C,
        true,
        Some("s2".to_string()),
        BroadcastScope::Custom,
        ids(&["s2", "a", "b"]),
        BroadcastScope::Panel,
    );
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(true));
    assert_eq!(view["sourceTabId"], json!("s2"));
    assert_eq!(view["scope"], json!("custom"));
    assert_eq!(view["lastScope"], json!("panel"));
    assert_eq!(view["targetTabIds"], json!(["s2", "a", "b"]));
}

#[test]
fn replace_can_mirror_the_idle_baseline() {
    let store = BroadcastStore::new();
    store.start(C, BroadcastScope::Panel, "src", &ids(&["t1", "t2"]));
    // Mirroring an inactive appStore slice (e.g. after a local stop) clears the
    // source/targets but retains the remembered scope, exactly like the slice.
    store.replace(
        C,
        false,
        None,
        BroadcastScope::Panel,
        Vec::new(),
        BroadcastScope::Panel,
    );
    let view = store.snapshot(C);
    assert_eq!(view["active"], json!(false));
    assert_eq!(view["sourceTabId"], Value::Null);
    assert_eq!(view["targetTabIds"], json!([]));
    assert_eq!(view["lastScope"], json!("panel"));
}

#[test]
fn membership_is_isolated_per_client() {
    let store = BroadcastStore::new();
    store.start("a", BroadcastScope::All, "a-src", &ids(&["a1"]));
    store.start("b", BroadcastScope::Custom, "b-src", &ids(&["b1"]));

    store.add_target("a", "a2");
    // Client b is untouched by client a's mutation.
    assert_eq!(store.snapshot("b")["targetTabIds"], json!(["b-src", "b1"]));
    assert_eq!(store.snapshot("b")["scope"], json!("custom"));

    store.stop("a");
    // Stopping a does not touch b.
    assert_eq!(store.snapshot("a")["active"], json!(false));
    assert_eq!(store.snapshot("b")["active"], json!(true));
    assert_eq!(store.snapshot("a")["targetTabIds"], json!([]));
    assert_eq!(store.snapshot("b")["targetTabIds"], json!(["b-src", "b1"]));
}
