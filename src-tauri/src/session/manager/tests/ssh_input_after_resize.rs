//! What is typed right behind a resize reaches an SSH shell whole and after it
//! (#6074).
//!
//! A Windows host lost the first character of a line typed behind two quick
//! resizes (`cho` for `echo`). The whole path from `send_input` to the server
//! runs here, so a loss or a reordering on our side of the wire would show.

use super::ssh_exit_status::{open_tab, server, CEILING};
use super::*;

use std::time::{Duration, Instant};

use termihub_core::backends::ssh::ki_test_server::ShellEvent;

use crate::session::registry::build_desktop_registry;

/// Resize/type rounds, each one resize pair (a panel closing and opening) and
/// the line typed behind it.
const ROUNDS: u16 = 50;

#[tokio::test(flavor = "multi_thread")]
async fn a_line_typed_behind_a_resize_reaches_the_shell_whole_and_after_it() {
    let server = server().await;
    let manager = SessionManager::new(build_desktop_registry(), Arc::new(FakeAgent::offline()));
    let emitter = MockEventEmitter::new();
    let session_id = open_tab(&manager, &emitter, &server, false).await;
    // The initial size, if any: only what this test sends is compared.
    let mut expected = server.observed.lock().unwrap().shell_events.clone();

    for round in 0..ROUNDS {
        for rows in [36, 31] {
            manager.resize(&session_id, 85, rows).await.expect("resize");
            expected.push(ShellEvent::Resize(85, u32::from(rows)));
        }
        let line = format!("echo ROUND:{round}:$((40+2)):\r");
        manager
            .send_input(&session_id, line.as_bytes())
            .await
            .expect("type");
        expected.push(ShellEvent::Input(line.into_bytes()));
    }

    let deadline = Instant::now() + CEILING;
    loop {
        let seen = server.observed.lock().unwrap().shell_events.clone();
        if seen.len() >= expected.len() {
            assert_eq!(seen, expected);
            return;
        }
        assert!(Instant::now() < deadline, "the shell saw only {seen:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
