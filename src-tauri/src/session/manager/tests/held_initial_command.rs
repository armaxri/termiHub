//! An initial command held because the shell never announces its prompt
//! (#5509): the tab is told after the notice delay, Send now types it exactly
//! once, and the notice clears when the prompt comes after all.

use super::initial_command::{emitted, open, probing_manager_with, sent, within, Writes};
use super::*;

use std::time::Duration;

const NOTICE_AFTER: Duration = Duration::from_millis(200);

/// A manager whose session has an uncapped probe that reports the prompt
/// once `at_prompt` is set (never, for a shell with bracketed paste off).
fn held_manager() -> (SessionManager, Writes, Arc<AtomicBool>) {
    let at_prompt = Arc::new(AtomicBool::new(false));
    let flag = at_prompt.clone();
    let probe: termihub_core::connection::PromptProbe =
        Arc::new(move || flag.load(Ordering::SeqCst));
    let (mut manager, writes) = probing_manager_with(b"user@host:~$ ", Some(probe), true);
    manager.set_held_notice_after(NOTICE_AFTER);
    (manager, writes, at_prompt)
}

fn helds(emitter: &MockEventEmitter) -> Vec<bool> {
    emitter
        .initial_command_helds
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.held)
        .collect()
}

#[tokio::test]
async fn the_tab_is_told_after_the_notice_delay_and_nothing_is_typed() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    assert!(helds(&emitter).is_empty(), "no notice before the delay");
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);
    let event = emitter.initial_command_helds.lock().unwrap()[0].clone();
    assert_eq!(event.session_id, sid);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(writes.lock().unwrap().is_empty(), "never typed blind");
    assert_eq!(emitted(&emitter), b"user@host:~$ ");
}

#[tokio::test]
async fn send_now_types_the_command_exactly_once() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    assert!(manager.send_held_initial_command(&sid));
    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    assert!(
        !manager.send_held_initial_command(&sid),
        "a second Send now sends nothing"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(&writes.lock().unwrap()[..], b"echo hi\r");
    assert_eq!(helds(&emitter), [true, false], "the notice clears");
}

#[tokio::test]
async fn send_now_before_the_notice_sends_nothing() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;

    assert!(!manager.send_held_initial_command(&sid));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_notice_clears_when_the_prompt_comes_after_all() {
    let (manager, writes, at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    at_prompt.store(true, Ordering::SeqCst);
    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(
        !manager.send_held_initial_command(&sid),
        "Send now after the prompt sent it does nothing"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(&writes.lock().unwrap()[..], b"echo hi\r");
}

#[tokio::test]
async fn a_prompt_before_the_delay_never_shows_the_notice() {
    let (manager, writes, at_prompt) = held_manager();
    at_prompt.store(true, Ordering::SeqCst);
    let emitter = MockEventEmitter::new();
    open(&manager, &emitter).await;

    assert!(within(Duration::from_secs(2), || sent(&writes)).await);
    tokio::time::sleep(NOTICE_AFTER * 2).await;
    assert!(helds(&emitter).is_empty());
}

#[tokio::test]
async fn closing_the_session_clears_the_notice() {
    let (manager, writes, _at_prompt) = held_manager();
    let emitter = MockEventEmitter::new();
    let sid = open(&manager, &emitter).await;
    assert!(within(Duration::from_secs(3), || helds(&emitter) == [true]).await);

    manager.close_session(&sid).await.expect("close");
    assert!(within(Duration::from_secs(2), || helds(&emitter) == [true, false]).await);
    assert!(!manager.send_held_initial_command(&sid));
    assert!(writes.lock().unwrap().is_empty());
}
