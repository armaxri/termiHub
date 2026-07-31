//! State-machine tests for [`RestoreCohortStore`], proving the cohort authority
//! matches the frontend `appStore` reducers (#1146 / #1227) transition for
//! transition: begin → settle → summary, the pre-failed and no-live shortcuts,
//! the `total == 0` no-op, stray-settle guards, and the per-client isolation the
//! client-scoped region requires.

use super::*;

const C: &str = "client-1";

fn ids(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_fresh_client_is_empty() {
    let store = RestoreCohortStore::new();
    let view = store.snapshot(C);
    assert_eq!(view["cohort"], Value::Null);
    assert_eq!(view["failedTabIds"], json!([]));
    assert_eq!(view["settlement"], Value::Null);
}

#[test]
fn begin_registers_the_cohort_with_tallies() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1", "t2", "t3"]), 0, None);
    assert_eq!(store.cohort_tallies(C), Some((3, 3, 0)));
    let view = store.snapshot(C);
    assert_eq!(view["cohort"]["total"], json!(3));
    assert_eq!(view["cohort"]["pending"], json!(["t1", "t2", "t3"]));
    assert_eq!(view["cohort"]["failed"], json!(0));
    assert_eq!(view["settlement"], Value::Null);
}

#[test]
fn a_pre_failed_count_seeds_total_and_failed() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1"]), 2, None);
    // total = 1 pending + 2 pre-failed; failed seeded at 2.
    assert_eq!(store.cohort_tallies(C), Some((3, 1, 2)));
}

#[test]
fn begin_with_total_zero_is_a_complete_no_op() {
    let store = RestoreCohortStore::new();
    // Seed a leftover retry set, then a zero-total begin must leave everything.
    store.begin_cohort(C, &ids(&["t1"]), 0, None);
    store.settle_tab(C, "t1", TabOutcome::Failed);
    assert_eq!(store.failed_restore_tab_ids(C), ids(&["t1"]));

    store.begin_cohort(C, &[], 0, None);
    assert_eq!(store.cohort_tallies(C), None, "no cohort started");
    assert_eq!(
        store.failed_restore_tab_ids(C),
        ids(&["t1"]),
        "retry set untouched by a no-op begin"
    );
}

#[test]
fn a_cohort_with_no_live_tabs_settles_immediately() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &[], 3, None); // all pre-failed, nothing to wait on
    assert_eq!(store.cohort_tallies(C), None, "settled at once");
    let view = store.snapshot(C);
    assert_eq!(view["settlement"]["seq"], json!(1));
    assert_eq!(view["settlement"]["total"], json!(3));
    assert_eq!(view["settlement"]["failed"], json!(3));
    assert_eq!(view["settlement"]["restored"], json!(0));
    // No live tabs settled, so no per-tab failed ids were recorded.
    assert_eq!(view["settlement"]["retryTabIds"], json!([]));
}

#[test]
fn settling_all_connected_summarizes_success_with_no_retry_set() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1", "t2"]), 0, None);
    store.settle_tab(C, "t1", TabOutcome::Connected);
    assert_eq!(
        store.cohort_tallies(C),
        Some((2, 1, 0)),
        "one still pending"
    );
    store.settle_tab(C, "t2", TabOutcome::Connected);

    assert_eq!(store.cohort_tallies(C), None, "cohort cleared on settle");
    let view = store.snapshot(C);
    assert_eq!(view["cohort"], Value::Null);
    assert_eq!(view["settlement"]["seq"], json!(1));
    assert_eq!(view["settlement"]["total"], json!(2));
    assert_eq!(view["settlement"]["restored"], json!(2));
    assert_eq!(view["settlement"]["failed"], json!(0));
    assert_eq!(view["settlement"]["retryTabIds"], json!([]));
    assert_eq!(view["failedTabIds"], json!([]));
}

#[test]
fn a_partial_failure_records_the_failed_tabs_for_bulk_retry() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1", "t2", "t3"]), 0, Some("toast-7".to_string()));
    store.settle_tab(C, "t1", TabOutcome::Connected);
    store.settle_tab(C, "t2", TabOutcome::Failed);
    store.settle_tab(C, "t3", TabOutcome::Failed);

    let view = store.snapshot(C);
    assert_eq!(view["settlement"]["total"], json!(3));
    assert_eq!(view["settlement"]["restored"], json!(1));
    assert_eq!(view["settlement"]["failed"], json!(2));
    assert_eq!(view["settlement"]["retryTabIds"], json!(["t2", "t3"]));
    assert_eq!(view["settlement"]["toastId"], json!("toast-7"));
    // The captured retry set drives the bulk "Reconnect failed tabs" control.
    assert_eq!(view["failedTabIds"], json!(["t2", "t3"]));
    assert_eq!(store.failed_restore_tab_ids(C), ids(&["t2", "t3"]));
}

#[test]
fn settling_an_unknown_or_duplicate_tab_is_ignored() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1", "t2"]), 0, None);
    store.settle_tab(C, "ghost", TabOutcome::Failed); // not in the cohort
    assert_eq!(store.cohort_tallies(C), Some((2, 2, 0)), "untouched");
    store.settle_tab(C, "t1", TabOutcome::Connected);
    store.settle_tab(C, "t1", TabOutcome::Failed); // stray duplicate settle
    assert_eq!(store.cohort_tallies(C), Some((2, 1, 0)), "no double count");
}

#[test]
fn settling_with_no_active_cohort_is_a_no_op() {
    let store = RestoreCohortStore::new();
    store.settle_tab(C, "t1", TabOutcome::Connected);
    assert_eq!(store.snapshot(C)["settlement"], Value::Null);
}

#[test]
fn a_fresh_cohort_supersedes_the_prior_retry_set() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1"]), 0, None);
    store.settle_tab(C, "t1", TabOutcome::Failed);
    assert_eq!(store.failed_restore_tab_ids(C), ids(&["t1"]));

    // A new restore begins — the leftover retry set is cleared immediately.
    store.begin_cohort(C, &ids(&["t2", "t3"]), 0, None);
    assert_eq!(store.failed_restore_tab_ids(C), Vec::<String>::new());
    assert_eq!(store.cohort_tallies(C), Some((2, 2, 0)));
}

#[test]
fn the_settlement_seq_advances_monotonically_per_settle() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1"]), 0, None);
    store.settle_tab(C, "t1", TabOutcome::Connected);
    assert_eq!(store.snapshot(C)["settlement"]["seq"], json!(1));

    store.begin_cohort(C, &ids(&["t2"]), 0, None);
    store.settle_tab(C, "t2", TabOutcome::Failed);
    assert_eq!(store.snapshot(C)["settlement"]["seq"], json!(2));
}

#[test]
fn duplicate_pending_ids_are_de_duplicated() {
    let store = RestoreCohortStore::new();
    store.begin_cohort(C, &ids(&["t1", "t1", "t2"]), 0, None);
    // Two distinct tabs, mirroring the frontend `new Set(pendingTabIds)`.
    assert_eq!(store.cohort_tallies(C), Some((2, 2, 0)));
    assert_eq!(store.snapshot(C)["cohort"]["pending"], json!(["t1", "t2"]));
}

#[test]
fn cohorts_are_isolated_per_client() {
    let store = RestoreCohortStore::new();
    store.begin_cohort("a", &ids(&["t1", "t2"]), 0, None);
    store.begin_cohort("b", &ids(&["t3"]), 0, None);

    store.settle_tab("a", "t1", TabOutcome::Failed);
    // Client b is untouched by client a's settle.
    assert_eq!(store.cohort_tallies("b"), Some((1, 1, 0)));
    store.settle_tab("b", "t3", TabOutcome::Connected);

    assert_eq!(store.snapshot("a")["cohort"]["failed"], json!(1));
    assert_eq!(store.snapshot("b")["settlement"]["restored"], json!(1));
    assert_eq!(
        store.snapshot("a")["settlement"],
        Value::Null,
        "a still open"
    );
}
