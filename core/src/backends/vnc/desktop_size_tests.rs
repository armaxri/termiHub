//! Tests for the VNC remote-resolution state (#3463).

use super::*;

fn screen(id: u32, width: u16, height: u16, flags: u32) -> DesktopScreen {
    DesktopScreen {
        id,
        x: 0,
        y: 0,
        width,
        height,
        flags,
    }
}

fn layout(
    reason: DesktopSizeReason,
    status: DesktopSizeStatus,
    (width, height): (u16, u16),
) -> VncEvent {
    VncEvent::DesktopLayout(ExtendedDesktopSize {
        reason,
        status,
        width,
        height,
        screens: vec![screen(42, width, height, 7)],
    })
}

fn initial(size: (u16, u16)) -> VncEvent {
    layout(DesktopSizeReason::Server, DesktopSizeStatus::Ok, size)
}

fn reply(status: DesktopSizeStatus, size: (u16, u16)) -> VncEvent {
    layout(DesktopSizeReason::Client, status, size)
}

fn size_of(req: &DesktopSizeRequest) -> (u16, u16) {
    (req.width, req.height)
}

const FIXED: ResolutionMode = ResolutionMode::Fixed {
    width: 1280,
    height: 720,
};

#[test]
fn only_server_mode_leaves_the_extension_out() {
    assert!(!ResolutionMode::Server.negotiates_layout());
    assert!(ResolutionMode::Dynamic.negotiates_layout());
    assert!(FIXED.negotiates_layout());
}

// ---------------------------------------------------------------- fixed ---

#[test]
fn fixed_size_is_requested_once_the_server_shows_support() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(FIXED);
    let req = ds
        .on_event(&initial((1024, 768)), now)
        .expect("fixed size requested right after the first layout");
    assert_eq!(size_of(&req), (1280, 720));
    // The server's screen id and flags are echoed in a single-screen layout.
    assert_eq!(req.screens, vec![screen(42, 1280, 720, 7)]);
    // Accepted: nothing further is requested.
    assert!(ds
        .on_event(&reply(DesktopSizeStatus::Ok, (1280, 720)), now)
        .is_none());
    // A later server-side change is not fought.
    assert!(ds.on_event(&initial((800, 600)), now).is_none());
}

#[test]
fn fixed_size_already_in_effect_sends_nothing() {
    let mut ds = DesktopSize::new(FIXED);
    assert!(ds.on_event(&initial((1280, 720)), Instant::now()).is_none());
}

#[test]
fn a_refused_fixed_size_is_not_retried() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(FIXED);
    assert!(ds.on_event(&initial((1024, 768)), now).is_some());
    assert!(ds
        .on_event(&reply(DesktopSizeStatus::OutOfResources, (1024, 768)), now)
        .is_none());
    assert!(ds.on_event(&initial((1024, 768)), now).is_none());
}

#[test]
fn fixed_mode_ignores_tab_resizes() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(FIXED);
    ds.on_event(&initial((1024, 768)), now);
    assert_eq!(ds.request(900, 700, now), ResizeOutcome::default());
    assert!(!ds.supports_dynamic_resize());
}

#[test]
fn fixed_mode_without_server_support_keeps_the_server_size() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(FIXED);
    assert!(ds
        .on_event(&VncEvent::DesktopLayoutUnsupported, now)
        .is_none());
    // Nothing is ever sent to a server without the extension.
    assert_eq!(ds.request(1280, 720, now), ResizeOutcome::default());
    assert!(ds.next_request(now).is_none());
}

// --------------------------------------------------------------- server ---

#[test]
fn server_mode_never_requests_a_size() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Server);
    assert!(ds.on_event(&initial((1024, 768)), now).is_none());
    assert_eq!(ds.request(900, 700, now), ResizeOutcome::default());
    assert!(!ds.supports_dynamic_resize());
}

// -------------------------------------------------------------- dynamic ---

#[test]
fn dynamic_resize_is_sent_once_supported() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    assert!(ds.supports_dynamic_resize(), "optimistic until known");
    assert!(ds.on_event(&initial((1024, 768)), now).is_none());
    let out = ds.request(900, 700, now);
    assert_eq!(out.request.as_ref().map(size_of), Some((900, 700)));
    assert!(out.notice.is_none());
}

#[test]
fn an_early_dynamic_request_waits_for_the_first_layout() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    assert_eq!(ds.request(900, 700, now), ResizeOutcome::default());
    let req = ds.on_event(&initial((1024, 768)), now).expect("sent now");
    assert_eq!(size_of(&req), (900, 700));
}

#[test]
fn requests_coalesce_while_one_awaits_its_reply() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    assert!(ds.request(900, 700, now).request.is_some());
    assert!(ds.request(910, 710, now).request.is_none());
    assert!(ds.request(920, 720, now).request.is_none());
    // The reply releases only the latest size.
    let next = ds
        .on_event(&reply(DesktopSizeStatus::Ok, (900, 700)), now)
        .expect("latest pending size");
    assert_eq!(size_of(&next), (920, 720));
    assert!(ds
        .on_event(&reply(DesktopSizeStatus::Ok, (920, 720)), now)
        .is_none());
}

#[test]
fn a_server_that_never_replies_does_not_wedge_resizing() {
    let start = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), start);
    assert!(ds.request(900, 700, start).request.is_some());
    assert!(ds.request(910, 710, start).request.is_none());
    let later = start + REPLY_TIMEOUT;
    let out = ds.request(920, 720, later);
    assert_eq!(out.request.as_ref().map(size_of), Some((920, 720)));
}

#[test]
fn the_current_size_is_not_requested_again() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    assert!(ds.request(1024, 768, now).request.is_none());
}

#[test]
fn dynamic_sizes_are_clamped_to_the_shared_range() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    let out = ds.request(10, u16::MAX, now);
    assert_eq!(out.request.as_ref().map(size_of), Some((200, 8192)));
}

#[test]
fn an_unsupported_server_is_surfaced_on_every_request() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(
        &VncEvent::SetResolution(vnc::Screen {
            width: 1024,
            height: 768,
        }),
        now,
    );
    ds.request(900, 700, now); // queued while unknown
    assert!(ds
        .on_event(&VncEvent::DesktopLayoutUnsupported, now)
        .is_none());
    assert!(!ds.supports_dynamic_resize());
    for _ in 0..2 {
        let out = ds.request(900, 700, now);
        assert!(out.request.is_none());
        let notice = out.notice.expect("surfaced");
        assert!(notice.contains("does not support"), "{notice}");
        assert!(notice.contains("1024x768"), "{notice}");
    }
}

#[test]
fn a_prohibited_resize_is_surfaced_once_and_stops_further_requests() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    assert!(ds.request(900, 700, now).request.is_some());
    assert!(ds
        .on_event(&reply(DesktopSizeStatus::Prohibited, (1024, 768)), now)
        .is_none());
    assert!(!ds.supports_dynamic_resize());
    let out = ds.request(910, 710, now);
    assert!(out.request.is_none());
    let notice = out.notice.expect("refusal surfaced");
    assert!(notice.contains("does not allow"), "{notice}");
    assert!(notice.contains("1024x768"), "{notice}");
    assert_eq!(ds.request(920, 720, now), ResizeOutcome::default());
}

#[test]
fn another_refusal_is_surfaced_but_later_sizes_are_still_tried() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    ds.request(8000, 8000, now);
    ds.on_event(&reply(DesktopSizeStatus::OutOfResources, (1024, 768)), now);
    assert!(ds.supports_dynamic_resize());
    let out = ds.request(900, 700, now);
    assert_eq!(out.request.as_ref().map(size_of), Some((900, 700)));
    assert!(out.notice.expect("surfaced").contains("out of resources"));
    // Reported once.
    ds.on_event(&reply(DesktopSizeStatus::Ok, (900, 700)), now);
    assert!(ds.request(910, 710, now).notice.is_none());
}

#[test]
fn unknown_and_invalid_layout_refusals_have_their_own_reason() {
    for (status, text) in [
        (DesktopSizeStatus::InvalidLayout, "screen layout"),
        (DesktopSizeStatus::Unknown(9), "status 9"),
    ] {
        let now = Instant::now();
        let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
        ds.on_event(&initial((1024, 768)), now);
        ds.request(900, 700, now);
        ds.on_event(&reply(status, (1024, 768)), now);
        let notice = ds.request(910, 710, now).notice.expect("surfaced");
        assert!(notice.contains(text), "{notice}");
    }
}

#[test]
fn another_clients_resize_does_not_clear_an_outstanding_request() {
    let now = Instant::now();
    let mut ds = DesktopSize::new(ResolutionMode::Dynamic);
    ds.on_event(&initial((1024, 768)), now);
    assert!(ds.request(900, 700, now).request.is_some());
    ds.on_event(
        &layout(
            DesktopSizeReason::OtherClient,
            DesktopSizeStatus::Ok,
            (800, 600),
        ),
        now,
    );
    // Still awaiting our reply: the next size is held back.
    assert!(ds.request(910, 710, now).request.is_none());
}
