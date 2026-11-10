//! Command-layer tests for the scheduler IPC (#5168).
//!
//! The commands run on `tauri::test::mock_app()` with the [`ScheduleManager`]
//! managed exactly as `lib.rs::setup()` does, so each test drives the real
//! `State` extraction, error mapping and `schedules-changed` notification.

use std::sync::{Arc, Mutex};

use chrono::{Duration, Utc};
use tauri::test::{mock_app, MockRuntime};
use tauri::{App, Listener, Manager, WebviewWindowBuilder};
use tempfile::TempDir;

use super::*;
use crate::schedules::config::{
    MissedRunPolicy, ScheduleAction, ScheduleRule, ScheduleRunOutcome, ScheduleTargets,
};
use crate::schedules::runner::EVENT_SCHEDULES_CHANGED;

struct Harness {
    app: App<MockRuntime>,
    dir: TempDir,
    changed: Arc<Mutex<usize>>,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let app = mock_app();
        app.manage(Arc::new(ScheduleManager::new_test(dir.path())));
        let changed = Arc::new(Mutex::new(0));
        let counter = changed.clone();
        app.listen_any(EVENT_SCHEDULES_CHANGED, move |_| {
            *counter.lock().unwrap() += 1;
        });
        Self { app, dir, changed }
    }

    fn handle(&self) -> AppHandle<MockRuntime> {
        self.app.handle().clone()
    }

    fn manager(&self) -> State<'_, Arc<ScheduleManager>> {
        self.app.state::<Arc<ScheduleManager>>()
    }

    fn changed(&self) -> usize {
        *self.changed.lock().unwrap()
    }

    fn window(&self, label: &str) -> tauri::Window<MockRuntime> {
        let webview = WebviewWindowBuilder::new(&self.app, label, Default::default())
            .build()
            .unwrap();
        webview.as_ref().window()
    }

    /// Save, confirm and enable a 10-minute schedule through the commands.
    fn enabled_schedule(&self) -> String {
        let view = save_schedule(input(), self.handle(), self.manager()).unwrap();
        let id = view.schedule.id.clone();
        set_schedule_enabled(id.clone(), true, true, self.handle(), self.manager()).unwrap();
        id
    }

    /// Tick minute by minute over the next `minutes`, with `main` listening;
    /// returns every fire token.
    fn tick_ahead(&self, minutes: i64) -> Vec<String> {
        let manager = self.manager();
        manager.mark_window_ready("main");
        let start = Utc::now();
        (1..=minutes)
            .flat_map(|m| {
                manager
                    .tick(start + Duration::minutes(m), &Utc, &["main".to_string()])
                    .fires
            })
            .map(|f| f.token)
            .collect()
    }

    /// Tick minute by minute until the first fire (within `minutes`) and stop
    /// there, so the run is still waiting on the windows' answers.
    fn first_fire(&self, minutes: i64) -> Option<String> {
        let manager = self.manager();
        manager.mark_window_ready("main");
        let start = Utc::now();
        (1..=minutes).find_map(|m| {
            manager
                .tick(start + Duration::minutes(m), &Utc, &["main".to_string()])
                .fires
                .into_iter()
                .next()
                .map(|f| f.token)
        })
    }
}

fn input() -> ScheduleInput {
    ScheduleInput {
        id: String::new(),
        name: "Health check".to_string(),
        action: ScheduleAction::Workflow {
            workflow_id: "wf-1".to_string(),
        },
        targets: ScheduleTargets::Connections {
            connection_ids: vec!["conn-a".to_string()],
        },
        rule: ScheduleRule::Interval { every_minutes: 10 },
        missed_runs: MissedRunPolicy::Skip,
        connect_if_needed: false,
    }
}

fn completed() -> WindowRunReport {
    WindowRunReport {
        outcome: ScheduleRunOutcome::Completed,
        message: None,
        targets_run: 1,
        workflow_run_ids: Vec::new(),
        macro_run_ids: Vec::new(),
    }
}

#[test]
fn save_stores_a_disabled_schedule_and_notifies() {
    let h = Harness::new();
    let view = save_schedule(input(), h.handle(), h.manager()).unwrap();
    assert!(!view.schedule.enabled);
    assert!(!view.schedule.id.is_empty());
    assert_eq!(h.changed(), 1);
    assert_eq!(list_schedules(h.manager()).unwrap().schedules.len(), 1);
}

#[test]
fn invalid_input_is_refused_without_a_notification() {
    let h = Harness::new();
    let mut bad = input();
    bad.targets = ScheduleTargets::Connections {
        connection_ids: Vec::new(),
    };
    assert!(save_schedule(bad, h.handle(), h.manager()).is_err());
    assert_eq!(h.changed(), 0);
    assert!(list_schedules(h.manager()).unwrap().schedules.is_empty());
}

#[test]
fn unknown_ids_are_errors_and_change_nothing() {
    let h = Harness::new();
    let err = set_schedule_enabled("nope".into(), true, true, h.handle(), h.manager())
        .expect_err("enabling an unknown schedule must fail");
    assert!(err.to_string().contains("nope"), "{err}");
    assert!(delete_schedule("nope".into(), h.handle(), h.manager()).is_err());
    assert_eq!(h.changed(), 0);
}

#[test]
fn the_first_enable_must_be_confirmed() {
    let h = Harness::new();
    let id = save_schedule(input(), h.handle(), h.manager())
        .unwrap()
        .schedule
        .id;
    assert!(set_schedule_enabled(id.clone(), true, false, h.handle(), h.manager()).is_err());
    assert!(
        !list_schedules(h.manager()).unwrap().schedules[0]
            .schedule
            .enabled
    );
    let view = set_schedule_enabled(id, true, true, h.handle(), h.manager()).unwrap();
    assert!(view.schedule.enabled);
}

#[test]
fn an_unknown_ack_or_report_is_ignored_without_a_notification() {
    // A late or stale run token is a no-op by design: the run already settled
    // (or never existed), so there is nothing to attribute it to.
    let h = Harness::new();
    let main = h.window("main");
    ack_schedule_run(
        "nope".into(),
        vec!["conn-a".into()],
        main.clone(),
        h.manager(),
    );
    report_schedule_run("nope".into(), completed(), main, h.handle(), h.manager()).unwrap();
    assert_eq!(h.changed(), 0);
}

#[test]
fn a_paused_scheduler_never_fires_and_resuming_restores_firing() {
    let h = Harness::new();
    h.enabled_schedule();

    let state = set_schedules_paused(true, h.handle(), h.manager()).unwrap();
    assert!(state.paused);
    assert!(h.tick_ahead(45).is_empty(), "a paused scheduler fired");

    assert!(
        !set_schedules_paused(false, h.handle(), h.manager())
            .unwrap()
            .paused
    );
    assert!(
        !h.tick_ahead(45).is_empty(),
        "a resumed scheduler never fired"
    );
}

#[test]
fn a_disabled_schedule_never_fires() {
    let h = Harness::new();
    let id = h.enabled_schedule();
    set_schedule_enabled(id, false, false, h.handle(), h.manager()).unwrap();
    assert!(h.tick_ahead(45).is_empty());
}

#[test]
fn a_deleted_schedule_never_fires() {
    let h = Harness::new();
    let id = h.enabled_schedule();
    delete_schedule(id, h.handle(), h.manager()).unwrap();
    assert!(h.tick_ahead(45).is_empty());
    assert!(list_schedules(h.manager()).unwrap().schedules.is_empty());
}

#[test]
fn report_schedule_run_settles_the_run_and_persists_it() {
    let h = Harness::new();
    h.enabled_schedule();
    let main = h.window("main");
    register_schedule_window(main.clone(), h.manager());
    let token = h.first_fire(15).expect("a fire");
    ack_schedule_run(
        token.clone(),
        vec!["conn-a".into()],
        main.clone(),
        h.manager(),
    );
    let before = h.changed();

    report_schedule_run(token, completed(), main, h.handle(), h.manager()).unwrap();
    assert_eq!(h.changed(), before + 1, "a settled run notifies");

    // A fresh manager over the same directory reads the result back from disk.
    let reloaded = ScheduleManager::new_test(h.dir.path());
    let state = reloaded.state(Utc::now(), &Utc).unwrap();
    let schedule = &state.schedules[0].schedule;
    assert!(schedule.last_run_at.is_some());
    assert_eq!(
        schedule.last_result.as_ref().map(|r| r.outcome),
        Some(ScheduleRunOutcome::Completed)
    );
}
