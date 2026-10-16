use super::*;

fn size(width: u32, height: u32) -> LayoutRequest {
    LayoutRequest::Size { width, height }
}

/// Take the waiting layout and record it as sent now.
fn send(gate: &mut ResizeGate) -> LayoutRequest {
    let layout = gate.take_sendable().expect("a layout to send");
    gate.sent(layout.clone(), Instant::now());
    layout
}

#[test]
fn a_request_before_the_channel_opens_is_kept_not_dropped() {
    // #4845: the size re-sent right after a reconnect arrives before the
    // Display Control channel opens. It must survive until the channel does.
    let mut gate = ResizeGate::default();
    gate.request(size(1000, 650));
    let first = gate.take_sendable().expect("a waiting layout");
    gate.defer(first);
    assert_eq!(gate.take_sendable(), Some(size(1000, 650)));
}

#[test]
fn a_deferred_request_does_not_override_a_newer_one() {
    let mut gate = ResizeGate::default();
    gate.request(size(1000, 650));
    let stale = gate.take_sendable().unwrap();
    gate.request(size(1280, 800));
    gate.defer(stale);
    assert_eq!(gate.take_sendable(), Some(size(1280, 800)));
}

#[test]
fn the_latest_request_wins() {
    let mut gate = ResizeGate::default();
    gate.request(size(800, 600));
    gate.request(size(1000, 650));
    assert_eq!(gate.take_sendable(), Some(size(1000, 650)));
    assert_eq!(gate.take_sendable(), None);
}

#[test]
fn a_new_request_waits_while_one_is_in_flight() {
    let mut gate = ResizeGate::default();
    gate.request(size(1000, 650));
    send(&mut gate);
    gate.request(size(1280, 800));
    assert_eq!(gate.take_sendable(), None, "held until the reactivation");
    gate.reactivated();
    assert_eq!(gate.take_sendable(), Some(size(1280, 800)));
}

#[test]
fn frame_acks_are_withheld_and_dropped_on_reactivation() {
    // xrdp deletes its encoder for the resize and crashes on a frame ack that
    // arrives meanwhile; the reactivation restarts its frame accounting.
    let mut gate = ResizeGate::default();
    assert!(!gate.in_flight());
    gate.request(size(1000, 650));
    send(&mut gate);
    assert!(gate.in_flight());
    gate.withhold(vec![1]);
    gate.withhold(vec![2]);
    gate.reactivated();
    assert!(!gate.in_flight());
    assert!(gate.expire().is_empty(), "obsolete acks are never sent");
    assert_eq!(
        gate.take_sendable(),
        None,
        "an answered layout is not re-sent"
    );
}

#[test]
fn withheld_acks_are_flushed_in_order_when_no_reactivation_comes() {
    let mut gate = ResizeGate::default();
    let now = Instant::now();
    gate.request(size(1000, 650));
    send(&mut gate);
    let deadline = gate.deadline().expect("an in-flight deadline");
    assert!(deadline >= now + RESIZE_ACK_HOLD && deadline <= Instant::now() + RESIZE_ACK_HOLD);
    gate.withhold(vec![1]);
    gate.withhold(vec![2]);
    assert_eq!(gate.expire(), vec![vec![1], vec![2]]);
    assert!(!gate.in_flight());
    assert_eq!(gate.deadline(), None);
}

#[test]
fn an_unanswered_layout_is_resent_a_bounded_number_of_times() {
    // xrdp ignores a layout that lands while it still logs the session on.
    let mut gate = ResizeGate::default();
    gate.request(size(1000, 650));
    for attempt in 1..=MAX_LAYOUT_ATTEMPTS {
        assert_eq!(send(&mut gate), size(1000, 650), "attempt {attempt}");
        gate.expire();
    }
    assert_eq!(
        gate.take_sendable(),
        None,
        "gives up after the last attempt"
    );
}

#[test]
fn a_newer_request_replaces_the_retry() {
    let mut gate = ResizeGate::default();
    gate.request(size(1000, 650));
    send(&mut gate);
    gate.request(size(1280, 800));
    gate.expire();
    assert_eq!(gate.take_sendable(), Some(size(1280, 800)));
}
