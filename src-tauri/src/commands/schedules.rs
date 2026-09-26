//! Tauri commands for scheduled workflows and macros (PROD-043).

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::schedules::manager::{
    ScheduleInput, ScheduleManager, ScheduleView, SchedulerState, WindowRunReport,
};
use crate::schedules::runner::EVENT_SCHEDULES_CHANGED;
use crate::utils::errors::TerminalError;

fn notify(app: &AppHandle) {
    if let Err(e) = app.emit(EVENT_SCHEDULES_CHANGED, ()) {
        tracing::warn!("failed to emit {EVENT_SCHEDULES_CHANGED}: {e}");
    }
}

/// The scheduler state: the global pause switch and every schedule with its
/// next run time.
#[tauri::command]
pub fn list_schedules(
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<SchedulerState, TerminalError> {
    manager.state(chrono::Utc::now(), &chrono::Local)
}

/// Add or update a schedule. New schedules are stored disabled; changing the
/// action or targets disables the schedule until it is confirmed again.
#[tauri::command]
pub fn save_schedule(
    schedule: ScheduleInput,
    app: AppHandle,
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<ScheduleView, TerminalError> {
    let view = manager.save(schedule, chrono::Utc::now(), &chrono::Local)?;
    notify(&app);
    Ok(view)
}

/// Delete a schedule.
#[tauri::command]
pub fn delete_schedule(
    schedule_id: String,
    app: AppHandle,
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<(), TerminalError> {
    manager.delete(&schedule_id)?;
    notify(&app);
    Ok(())
}

/// Enable or disable a schedule. The first enable must pass `confirmed: true`
/// (the user confirmed the hosts it sends input to).
#[tauri::command]
pub fn set_schedule_enabled(
    schedule_id: String,
    enabled: bool,
    confirmed: bool,
    app: AppHandle,
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<ScheduleView, TerminalError> {
    let view = manager.set_enabled(
        &schedule_id,
        enabled,
        confirmed,
        chrono::Utc::now(),
        &chrono::Local,
    )?;
    notify(&app);
    Ok(view)
}

/// Pause or resume all schedules.
#[tauri::command]
pub fn set_schedules_paused(
    paused: bool,
    app: AppHandle,
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<SchedulerState, TerminalError> {
    let state = manager.set_paused(paused, chrono::Utc::now(), &chrono::Local)?;
    notify(&app);
    Ok(state)
}

/// A window's report of a fired run (`token` from the `schedule-fire` event).
#[tauri::command]
pub fn report_schedule_run(
    token: String,
    report: WindowRunReport,
    window: tauri::Window,
    app: AppHandle,
    manager: State<'_, Arc<ScheduleManager>>,
) -> Result<(), TerminalError> {
    if manager.report(&token, window.label(), report, chrono::Utc::now())? {
        notify(&app);
    }
    Ok(())
}
