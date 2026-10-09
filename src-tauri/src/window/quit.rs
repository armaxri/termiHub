//! Explicit-quit coordination (#4296, audit UX2-005).
//!
//! Closing a window runs the frontend close decision (#1903 / #4314): a window
//! that would lose a non-persistent session or an unsaved editor raises the
//! detach-vs-terminate dialog. An explicit **quit** (Cmd+Q, the app menu's
//! Quit, `AppHandle::exit`) used to bypass that dialog entirely, ending every
//! live session and discarding unsaved editors without asking.
//!
//! This module routes every explicit quit through the same decision:
//!
//! 1. The quit arrives as `RunEvent::ExitRequested { code: Some(_) }`. On macOS,
//!    Cmd+Q / "Quit termiHub" is a custom menu item ([`QUIT_MENU_ID`]) that calls
//!    `AppHandle::exit(0)`, because the stock predefined Quit item sends
//!    `-[NSApp terminate:]`, which ends the process without ever raising an
//!    `ExitRequested` that could be prevented.
//! 2. [`decide_exit_request`] prevents the exit while windows are open and the
//!    quit is not yet confirmed. [`QuitCoordinator::begin`] records which windows
//!    must answer, and every window gets [`QUIT_REQUESTED_EVENT`].
//! 3. Each window classifies its own tabs with the window-close rules. A window
//!    with nothing to lose answers `quit_window_ready` straight away. A window
//!    that would lose something acknowledges with `quit_window_prompting` and
//!    shows the decision dialog. Its "Quit" answers `quit_window_ready`, and its
//!    "Cancel" calls `cancel_quit`, which aborts the whole quit and sends
//!    [`QUIT_CANCELLED_EVENT`] so other windows drop their dialogs.
//! 4. When the last pending window is ready, the phase becomes
//!    [`QuitPhase::Confirmed`] and the backend calls `AppHandle::exit(0)` again.
//!    That second `ExitRequested` proceeds.
//!
//! # Bounds (never hang a quit)
//!
//! * **Repeated quit.** A second Cmd+Q while the dialog is open is prevented and
//!   ignored ([`ExitDecision::PreventWhilePrompting`]). It neither raises a second
//!   dialog nor force-quits.
//! * **Unresponsive window.** A window must acknowledge within
//!   [`QUIT_ACK_TIMEOUT`], either ready or prompting. One that does neither (a
//!   hung or crashed webview) stops blocking the quit when the timeout fires
//!   ([`QuitCoordinator::ack_timeout`]), so Cmd+Q never becomes a no-op. A window
//!   that *is* showing the dialog waits for the user, however long that takes.
//! * **OS shutdown / logout.** These never reach this flow. On macOS they arrive
//!   as `-[NSApp terminate:]` (as does the Dock's Quit), which ends the process
//!   with `RunEvent::Exit` and no chance to prevent it. On Windows and Linux the
//!   session manager closes the windows itself and bounds any app that holds a
//!   close open. Either way shutdown proceeds without waiting on a dialog; the
//!   synchronous part of the app teardown still runs from `RunEvent::Exit`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use super::recover;

/// Id of the custom "Quit termiHub" (Cmd+Q) menu item that replaces the stock
/// predefined Quit on macOS, so a quit raises a preventable `ExitRequested`.
pub const QUIT_MENU_ID: &str = "termihub-quit";

/// Event emitted to every window when an explicit quit needs their decision.
pub const QUIT_REQUESTED_EVENT: &str = "app-quit-requested";

/// Event emitted to every window when a pending quit was cancelled, so any
/// other window still showing the quit dialog closes it.
pub const QUIT_CANCELLED_EVENT: &str = "app-quit-cancelled";

/// How long a window has to acknowledge a quit request (ready or prompting)
/// before it is treated as unresponsive and stops blocking the quit.
pub const QUIT_ACK_TIMEOUT: Duration = Duration::from_secs(5);

/// Where an explicit quit stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPhase {
    /// No quit in progress.
    Idle,
    /// Windows were asked and at least one has not answered yet.
    Prompting,
    /// Every window agreed (or none was open); the next exit proceeds.
    Confirmed,
}

/// What the `RunEvent::ExitRequested` handler must do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// Let the exit proceed.
    Proceed,
    /// macOS: the last window closed; keep the app alive in the Dock (#1903).
    KeepAliveInDock,
    /// Prevent the exit and ask the windows ([`QUIT_REQUESTED_EVENT`]).
    PreventAndPrompt,
    /// Prevent the exit; a quit prompt is already open, so do not raise another.
    PreventWhilePrompting,
}

/// Decide an `ExitRequested`, given its exit `code` (`None` = the last window
/// closed, `Some` = an explicit quit), the platform, how many windows are still
/// open, and the current [`QuitPhase`].
///
/// * A confirmed quit always proceeds.
/// * `code == None`: every window already went through its own close prompt.
///   macOS keeps the app alive in the Dock unless a quit is in progress, in which
///   case closing the last window completes it. Windows and Linux quit.
/// * `code == Some`: with no window open there is nothing to ask about, so it
///   proceeds. Otherwise the first request prompts and a repeat while the prompt
///   is open is swallowed.
pub fn decide_exit_request(
    code: Option<i32>,
    is_macos: bool,
    open_windows: usize,
    phase: QuitPhase,
) -> ExitDecision {
    if phase == QuitPhase::Confirmed {
        return ExitDecision::Proceed;
    }
    match code {
        None if is_macos && phase == QuitPhase::Idle => ExitDecision::KeepAliveInDock,
        None => ExitDecision::Proceed,
        Some(_) if open_windows == 0 => ExitDecision::Proceed,
        Some(_) if phase == QuitPhase::Prompting => ExitDecision::PreventWhilePrompting,
        Some(_) => ExitDecision::PreventAndPrompt,
    }
}

/// Result of [`QuitCoordinator::begin`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginOutcome {
    /// Windows must be asked; `generation` identifies this quit attempt for its
    /// acknowledgement timeout.
    Started { generation: u64 },
    /// A quit prompt is already open; do nothing.
    AlreadyPrompting,
    /// Nothing to ask (no window open, or already confirmed); exit now.
    ExitNow,
}

/// Result of a window answering (or disappearing, or timing out).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyOutcome {
    /// That was the last pending window; the quit is confirmed, exit now.
    ExitNow,
    /// Other windows still have to answer.
    Waiting,
    /// No quit is in progress; nothing to do.
    NotQuitting,
}

#[derive(Debug)]
struct QuitState {
    phase: QuitPhase,
    /// Windows that still have to answer ready.
    pending: HashSet<String>,
    /// Windows that have not acknowledged at all yet (neither ready nor
    /// prompting); dropped from `pending` if the acknowledgement times out.
    unacked: HashSet<String>,
    /// Bumped on every new quit attempt so a stale timeout cannot touch a
    /// later attempt.
    generation: u64,
}

impl QuitState {
    fn reset(&mut self) {
        self.phase = QuitPhase::Idle;
        self.pending.clear();
        self.unacked.clear();
    }

    fn settle(&mut self) -> ReadyOutcome {
        if self.pending.is_empty() {
            self.phase = QuitPhase::Confirmed;
            self.unacked.clear();
            ReadyOutcome::ExitNow
        } else {
            ReadyOutcome::Waiting
        }
    }
}

/// Backend state for the explicit-quit handshake. Managed app state.
#[derive(Debug)]
pub struct QuitCoordinator {
    state: Mutex<QuitState>,
    teardown_done: AtomicBool,
}

impl Default for QuitCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl QuitCoordinator {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(QuitState {
                phase: QuitPhase::Idle,
                pending: HashSet::new(),
                unacked: HashSet::new(),
                generation: 0,
            }),
            teardown_done: AtomicBool::new(false),
        }
    }

    /// The current phase.
    pub fn phase(&self) -> QuitPhase {
        recover(self.state.lock()).phase
    }

    /// Start a quit that must be answered by the windows labelled `windows`.
    pub fn begin<I>(&self, windows: I) -> BeginOutcome
    where
        I: IntoIterator<Item = String>,
    {
        let mut state = recover(self.state.lock());
        match state.phase {
            QuitPhase::Confirmed => return BeginOutcome::ExitNow,
            QuitPhase::Prompting => return BeginOutcome::AlreadyPrompting,
            QuitPhase::Idle => {}
        }
        let pending: HashSet<String> = windows.into_iter().collect();
        if pending.is_empty() {
            state.phase = QuitPhase::Confirmed;
            return BeginOutcome::ExitNow;
        }
        state.generation += 1;
        state.phase = QuitPhase::Prompting;
        state.unacked = pending.clone();
        state.pending = pending;
        BeginOutcome::Started {
            generation: state.generation,
        }
    }

    /// The window `label` is showing the quit dialog; it no longer counts as
    /// unresponsive, so the acknowledgement timeout will wait for it.
    pub fn ack_prompting(&self, label: &str) {
        let mut state = recover(self.state.lock());
        if state.phase == QuitPhase::Prompting {
            state.unacked.remove(label);
        }
    }

    /// The window `label` agreed to quit (nothing to lose, or the user chose
    /// "Quit" in its dialog).
    pub fn window_ready(&self, label: &str) -> ReadyOutcome {
        let mut state = recover(self.state.lock());
        if state.phase != QuitPhase::Prompting {
            return ReadyOutcome::NotQuitting;
        }
        state.unacked.remove(label);
        state.pending.remove(label);
        state.settle()
    }

    /// The window `label` was destroyed while a quit was pending: it can no
    /// longer answer, and whatever it held is already gone.
    pub fn window_gone(&self, label: &str) -> ReadyOutcome {
        self.window_ready(label)
    }

    /// The acknowledgement window of quit attempt `generation` elapsed: every
    /// window that never answered stops blocking the quit.
    pub fn ack_timeout(&self, generation: u64) -> ReadyOutcome {
        let mut state = recover(self.state.lock());
        if state.phase != QuitPhase::Prompting || state.generation != generation {
            return ReadyOutcome::NotQuitting;
        }
        let unresponsive: Vec<String> = state.unacked.drain().collect();
        for label in &unresponsive {
            state.pending.remove(label);
        }
        state.settle()
    }

    /// The user cancelled the quit in some window. Returns whether a quit was
    /// actually pending (and so whether other windows need telling).
    pub fn cancel(&self) -> bool {
        let mut state = recover(self.state.lock());
        let was_prompting = state.phase == QuitPhase::Prompting;
        if was_prompting {
            state.reset();
        }
        was_prompting
    }

    /// Confirm the quit without asking any window (a test-harness quit).
    #[cfg(any(test, feature = "test-bridge"))]
    pub fn force_confirm(&self) {
        let mut state = recover(self.state.lock());
        state.phase = QuitPhase::Confirmed;
        state.pending.clear();
        state.unacked.clear();
    }

    /// Claim the one-time app teardown. Returns `true` exactly once, so the
    /// teardown runs once even when both an exit path and `RunEvent::Exit`
    /// reach it.
    pub fn take_teardown(&self) -> bool {
        !self.teardown_done.swap(true, Ordering::SeqCst)
    }
}

/// Start (or swallow a repeat of) an explicit quit: ask every open window via
/// [`QUIT_REQUESTED_EVENT`] and arm the acknowledgement timeout.
///
/// Called from the `RunEvent::ExitRequested` handler after it prevented the
/// exit. Emitting must not happen on the event-loop thread (it re-enters a
/// `RefCell` Tauri already holds), so the emit and the timeout run on the async
/// runtime.
pub fn start_quit_flow(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    let Some(coordinator) = app.try_state::<QuitCoordinator>() else {
        tracing::warn!("Quit coordinator missing; letting the quit proceed (#4296)");
        app.exit(0);
        return;
    };
    let labels: Vec<String> = app.webview_windows().into_keys().collect();
    match coordinator.begin(labels) {
        BeginOutcome::AlreadyPrompting => {
            tracing::info!("Quit already awaiting a decision; ignoring repeat (#4296)");
        }
        BeginOutcome::ExitNow => {
            tracing::info!("Quit needs no decision; exiting (#4296)");
            app.exit(0);
        }
        BeginOutcome::Started { generation } => {
            tracing::info!("Quit requested; asking windows to confirm (#4296)");
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle.emit(QUIT_REQUESTED_EVENT, ()) {
                    tracing::warn!("Failed to emit {QUIT_REQUESTED_EVENT}: {e}");
                }
                tokio::time::sleep(QUIT_ACK_TIMEOUT).await;
                let outcome = handle
                    .try_state::<QuitCoordinator>()
                    .map(|c| c.ack_timeout(generation));
                if outcome == Some(ReadyOutcome::ExitNow) {
                    tracing::warn!(
                        "Windows did not answer the quit request in time; exiting (#4296)"
                    );
                    handle.exit(0);
                }
            });
        }
    }
}

/// Act on a [`ReadyOutcome`]: exit once the last pending window agreed.
pub fn finish_if_ready(app: &tauri::AppHandle, outcome: ReadyOutcome) {
    if outcome == ReadyOutcome::ExitNow {
        tracing::info!("All windows confirmed the quit; exiting (#4296)");
        app.exit(0);
    }
}

/// Install the macOS app menu with a preventable Quit (Cmd+Q), and its handler.
///
/// Tauri's default macOS menu ends with the predefined Quit item, which sends
/// `-[NSApp terminate:]` and so exits without a preventable `ExitRequested`.
/// This keeps that default menu but swaps the Quit item for a custom one with
/// the same label and accelerator that calls `AppHandle::exit(0)`, which the
/// `ExitRequested` handler routes through the quit decision. Windows and Linux
/// have no default menu bar (Tauri adds none), so the builder is unchanged there.
pub fn install_quit_menu(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(target_os = "macos")]
    {
        builder.menu(build_macos_menu).on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                tracing::info!("Quit chosen from the app menu (#4296)");
                app.exit(0);
            }
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

/// Tauri's default macOS menu with the predefined Quit replaced by
/// [`QUIT_MENU_ID`]. If the Quit item cannot be found, the stock menu is kept.
#[cfg(target_os = "macos")]
fn build_macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app)?;
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        tracing::warn!("App menu not found; keeping the stock Quit (#4296)");
        return Ok(menu);
    };
    let items = app_menu.items()?;
    let quit_position = items.iter().position(|item| match item {
        MenuItemKind::Predefined(p) => p.text().map(|t| t.starts_with("Quit")).unwrap_or(false),
        _ => false,
    });
    let Some(position) = quit_position else {
        tracing::warn!("Predefined Quit item not found; keeping the stock Quit (#4296)");
        return Ok(menu);
    };
    app_menu.remove_at(position)?;
    let label = format!("Quit {}", app.package_info().name);
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, label, true, Some("CmdOrCtrl+Q"))?;
    app_menu.insert(&quit, position)?;
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    // ── decide_exit_request ──────────────────────────────────────────────

    #[test]
    fn explicit_quit_with_open_windows_prevents_and_prompts() {
        for is_macos in [true, false] {
            assert_eq!(
                decide_exit_request(Some(0), is_macos, 1, QuitPhase::Idle),
                ExitDecision::PreventAndPrompt
            );
        }
    }

    #[test]
    fn explicit_quit_with_no_windows_exits_at_once() {
        for is_macos in [true, false] {
            assert_eq!(
                decide_exit_request(Some(0), is_macos, 0, QuitPhase::Idle),
                ExitDecision::Proceed
            );
        }
    }

    #[test]
    fn confirmed_quit_goes_through() {
        for code in [None, Some(0)] {
            for is_macos in [true, false] {
                assert_eq!(
                    decide_exit_request(code, is_macos, 3, QuitPhase::Confirmed),
                    ExitDecision::Proceed
                );
            }
        }
    }

    #[test]
    fn repeat_quit_while_prompting_neither_reprompts_nor_force_quits() {
        assert_eq!(
            decide_exit_request(Some(0), true, 2, QuitPhase::Prompting),
            ExitDecision::PreventWhilePrompting
        );
    }

    #[test]
    fn last_window_close_keeps_macos_alive_and_quits_elsewhere() {
        assert_eq!(
            decide_exit_request(None, true, 0, QuitPhase::Idle),
            ExitDecision::KeepAliveInDock
        );
        assert_eq!(
            decide_exit_request(None, false, 0, QuitPhase::Idle),
            ExitDecision::Proceed
        );
    }

    #[test]
    fn last_window_closing_during_a_quit_completes_it_on_macos() {
        assert_eq!(
            decide_exit_request(None, true, 0, QuitPhase::Prompting),
            ExitDecision::Proceed
        );
    }

    // ── QuitCoordinator ──────────────────────────────────────────────────

    #[test]
    fn begin_with_windows_starts_prompting() {
        let q = QuitCoordinator::new();
        assert!(matches!(
            q.begin(labels(&["main"])),
            BeginOutcome::Started { .. }
        ));
        assert_eq!(q.phase(), QuitPhase::Prompting);
    }

    #[test]
    fn begin_without_windows_confirms_at_once() {
        let q = QuitCoordinator::new();
        assert_eq!(q.begin(Vec::new()), BeginOutcome::ExitNow);
        assert_eq!(q.phase(), QuitPhase::Confirmed);
    }

    #[test]
    fn second_begin_while_prompting_is_swallowed() {
        let q = QuitCoordinator::new();
        q.begin(labels(&["main"]));
        assert_eq!(q.begin(labels(&["main"])), BeginOutcome::AlreadyPrompting);
        assert_eq!(q.phase(), QuitPhase::Prompting);
    }

    #[test]
    fn exits_only_once_every_window_is_ready() {
        let q = QuitCoordinator::new();
        q.begin(labels(&["main", "win-1"]));
        assert_eq!(q.window_ready("main"), ReadyOutcome::Waiting);
        assert_eq!(q.phase(), QuitPhase::Prompting);
        assert_eq!(q.window_ready("win-1"), ReadyOutcome::ExitNow);
        assert_eq!(q.phase(), QuitPhase::Confirmed);
    }

    #[test]
    fn cancel_aborts_the_quit_and_a_later_quit_prompts_again() {
        let q = QuitCoordinator::new();
        q.begin(labels(&["main", "win-1"]));
        q.window_ready("main");
        assert!(q.cancel());
        assert_eq!(q.phase(), QuitPhase::Idle);
        // A late ready from the other window must not resurrect the quit.
        assert_eq!(q.window_ready("win-1"), ReadyOutcome::NotQuitting);
        assert!(matches!(
            q.begin(labels(&["main", "win-1"])),
            BeginOutcome::Started { .. }
        ));
    }

    #[test]
    fn cancel_without_a_pending_quit_reports_false() {
        let q = QuitCoordinator::new();
        assert!(!q.cancel());
    }

    #[test]
    fn destroyed_window_stops_blocking_the_quit() {
        let q = QuitCoordinator::new();
        q.begin(labels(&["main", "win-1"]));
        q.window_ready("main");
        assert_eq!(q.window_gone("win-1"), ReadyOutcome::ExitNow);
    }

    #[test]
    fn ack_timeout_drops_only_unresponsive_windows() {
        let q = QuitCoordinator::new();
        let BeginOutcome::Started { generation } = q.begin(labels(&["main", "win-1", "win-2"]))
        else {
            panic!("expected a started quit");
        };
        // main shows the dialog; win-1 never answers; win-2 is ready.
        q.ack_prompting("main");
        q.window_ready("win-2");
        assert_eq!(q.ack_timeout(generation), ReadyOutcome::Waiting);
        // The dialog in main is still awaited.
        assert_eq!(q.phase(), QuitPhase::Prompting);
        assert_eq!(q.window_ready("main"), ReadyOutcome::ExitNow);
    }

    #[test]
    fn ack_timeout_exits_when_no_window_answered() {
        let q = QuitCoordinator::new();
        let BeginOutcome::Started { generation } = q.begin(labels(&["main"])) else {
            panic!("expected a started quit");
        };
        assert_eq!(q.ack_timeout(generation), ReadyOutcome::ExitNow);
    }

    #[test]
    fn stale_ack_timeout_does_not_touch_a_later_quit() {
        let q = QuitCoordinator::new();
        let BeginOutcome::Started { generation: first } = q.begin(labels(&["main"])) else {
            panic!("expected a started quit");
        };
        q.cancel();
        q.begin(labels(&["main"]));
        assert_eq!(q.ack_timeout(first), ReadyOutcome::NotQuitting);
        assert_eq!(q.phase(), QuitPhase::Prompting);
    }

    #[test]
    fn force_confirm_lets_the_next_exit_proceed() {
        let q = QuitCoordinator::new();
        q.begin(labels(&["main"]));
        q.force_confirm();
        assert_eq!(
            decide_exit_request(Some(0), true, 1, q.phase()),
            ExitDecision::Proceed
        );
    }

    #[test]
    fn teardown_is_claimed_exactly_once() {
        let q = QuitCoordinator::new();
        assert!(q.take_teardown());
        assert!(!q.take_teardown());
    }
}
