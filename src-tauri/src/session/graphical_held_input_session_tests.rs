//! Held-input release on a live graphical session (#3402): takeover, input
//! from a new controller, explicit release-all, and reconnect — driven through
//! the manager and the command-layer gates against the recording fake backend.

use super::*;

use crate::commands::remote_desktop::{gated_release_input, gated_send_input, release_on_takeover};
use crate::window::WindowManager;

fn key(code: &str, pressed: bool) -> InputEvent {
    InputEvent::Key {
        code: code.to_string(),
        pressed,
    }
}

fn pointer(x: u32, y: u32, buttons: u8) -> InputEvent {
    InputEvent::Pointer { x, y, buttons }
}

impl Control {
    /// Every input event any backend received, in order (dial numbers dropped).
    fn input_log(&self) -> Vec<InputEvent> {
        self.inputs
            .lock()
            .unwrap()
            .iter()
            .map(|(_, e)| e.clone())
            .collect()
    }

    /// The input events received after the first `skip`, with dial numbers.
    fn inputs_after(&self, skip: usize) -> Vec<(u32, InputEvent)> {
        self.inputs.lock().unwrap()[skip..].to_vec()
    }
}

/// Window A holds Shift and the left button, then presses/releases KeyA.
async fn hold_in(h: &Harness, wm: &WindowManager, window: &str) {
    for event in [
        key("ShiftLeft", true),
        key("KeyA", true),
        key("KeyA", false),
        pointer(7, 9, 1),
    ] {
        assert!(gated_send_input(&h.mgr, wm, window, &h.sid, event)
            .await
            .expect("owner input"));
    }
}

#[tokio::test(start_paused = true)]
async fn takeover_releases_the_evicted_windows_held_input() {
    let h = open(serde_json::json!({}), vec![]).await;
    let wm = WindowManager::new();
    wm.claim(&h.sid, "main");
    hold_in(&h, &wm, "main").await;
    let before = h.ctl.input_log().len();

    // B takes the session over: A's input is now gated off, so the backend
    // releases what A left held on the remote.
    wm.claim(&h.sid, "win-1");
    assert_eq!(release_on_takeover(&h.mgr, &h.sid, "win-1").await, 2);
    assert_eq!(
        h.ctl.inputs_after(before),
        vec![(1, key("ShiftLeft", false)), (1, pointer(7, 9, 0))],
        "the remote sees Shift released and the button lifted at its last position"
    );

    // Idempotent: nothing is held any more.
    assert_eq!(release_on_takeover(&h.mgr, &h.sid, "win-1").await, 0);
    // The evicted window cannot re-press anything.
    assert!(
        !gated_send_input(&h.mgr, &wm, "main", &h.sid, key("ShiftLeft", true))
            .await
            .expect("evicted input")
    );
    assert_eq!(h.ctl.input_log().len(), before + 2);
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn takeover_keeps_input_the_new_owner_already_holds() {
    let h = open(serde_json::json!({}), vec![]).await;
    let wm = WindowManager::new();
    wm.claim(&h.sid, "main");
    hold_in(&h, &wm, "main").await;

    // B claims and presses Ctrl before the (asynchronous) takeover release
    // ran: A's held input is released ahead of B's key, B's key survives.
    wm.claim(&h.sid, "win-1");
    let before = h.ctl.input_log().len();
    assert!(
        gated_send_input(&h.mgr, &wm, "win-1", &h.sid, key("ControlLeft", true))
            .await
            .expect("new owner input")
    );
    assert_eq!(
        h.ctl.input_log()[before..].to_vec(),
        vec![
            key("ShiftLeft", false),
            pointer(7, 9, 0),
            key("ControlLeft", true)
        ],
        "the previous controller's input is released before the new owner's"
    );
    assert_eq!(
        release_on_takeover(&h.mgr, &h.sid, "win-1").await,
        0,
        "the late takeover release leaves the new owner's held Ctrl alone"
    );
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn explicit_release_all_is_owner_gated() {
    let h = open(serde_json::json!({}), vec![]).await;
    let wm = WindowManager::new();
    wm.claim(&h.sid, "main");
    hold_in(&h, &wm, "main").await;

    assert_eq!(
        gated_release_input(&h.mgr, &wm, "win-1", &h.sid)
            .await
            .expect("non-owner release"),
        0,
        "a non-owning window cannot release the owner's input"
    );
    let before = h.ctl.input_log().len();
    assert_eq!(
        gated_release_input(&h.mgr, &wm, "main", &h.sid)
            .await
            .expect("owner release"),
        2
    );
    assert_eq!(
        h.ctl.input_log()[before..].to_vec(),
        vec![key("ShiftLeft", false), pointer(7, 9, 0)]
    );
    assert_eq!(
        gated_release_input(&h.mgr, &wm, "main", &h.sid)
            .await
            .expect("repeat release"),
        0,
        "release-all is idempotent"
    );
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn reconnect_releases_held_input_on_the_fresh_connection_and_clears_it() {
    let h = open(serde_json::json!({}), vec![Dial::Ok]).await;
    let wm = WindowManager::new();
    hold_in(&h, &wm, "main").await;
    let before = h.ctl.input_log().len();

    h.ctl.drop_stream();
    wait_until("re-dial", || h.ctl.dials() == 2).await;
    wait_until("release on the fresh connection", || {
        h.ctl.input_log().len() == before + 2
    })
    .await;
    assert_eq!(
        h.ctl.inputs_after(before),
        vec![(2, key("ShiftLeft", false)), (2, pointer(7, 9, 0))],
        "the re-dialled connection receives the ups for what was held at the drop"
    );

    // The record was cleared: nothing is left to release.
    assert_eq!(
        h.mgr
            .release_held_input(&h.sid, None)
            .await
            .expect("release"),
        0
    );
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn takeover_of_a_non_graphical_session_is_a_no_op() {
    let h = open(serde_json::json!({}), vec![]).await;
    assert_eq!(
        release_on_takeover(&h.mgr, "terminal-session", "win-1").await,
        0
    );
    h.mgr.disconnect(&h.sid, h.sink.clone()).await.unwrap();
}
