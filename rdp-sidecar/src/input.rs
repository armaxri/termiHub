//! Translation from the shared, protocol-agnostic [`InputEvent`] into RDP
//! fast-path input PDUs.
//!
//! The shared input pipeline (#1680) delivers keyboard/mouse/wheel input as
//! [`InputEvent`]s with absolute button state (DOM `MouseEvent.buttons`
//! convention). RDP fast-path input is **edge-triggered** for buttons — a
//! press and a release are distinct PDUs — so pointer translation diffs the new
//! button mask against the previous one and emits the button transitions plus a
//! move. Keyboard events carry a PC/AT scancode (from [`super::keymap`]) with an
//! extended flag. These functions are pure so the mapping is unit-testable
//! without a live session.

use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp::pdu::input::mouse::PointerFlags;
use ironrdp::pdu::input::MousePdu;

use termihub_core::connection::InputEvent;

use super::keymap::Scancode;

/// DOM `MouseEvent.buttons` bit for the left button.
const DOM_LEFT: u8 = 0b001;
/// DOM `MouseEvent.buttons` bit for the right button.
const DOM_RIGHT: u8 = 0b010;
/// DOM `MouseEvent.buttons` bit for the middle button.
const DOM_MIDDLE: u8 = 0b100;

/// Wheel rotation units per notch (RDP convention: 120 units == one detent).
const WHEEL_UNITS: i16 = 120;

/// Clamp a framebuffer coordinate (`u32`) into the `u16` the RDP wire uses.
fn clamp_pos(v: u32) -> u16 {
    v.min(u16::MAX as u32) as u16
}

/// Build the fast-path keyboard event for a scancode press/release.
pub fn key_event(scancode: Scancode, pressed: bool) -> FastPathInputEvent {
    let mut flags = KeyboardFlags::empty();
    if !pressed {
        flags |= KeyboardFlags::RELEASE;
    }
    if scancode.extended {
        flags |= KeyboardFlags::EXTENDED;
    }
    // Set-1 make codes are all single-byte; the keymap never yields > 0xFF.
    FastPathInputEvent::KeyboardEvent(flags, scancode.code as u8)
}

/// Build one `MOVE` mouse PDU at `(x, y)`.
fn move_event(x: u16, y: u16) -> FastPathInputEvent {
    FastPathInputEvent::MouseEvent(MousePdu {
        flags: PointerFlags::MOVE,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })
}

/// Build a button transition PDU (`down == true` for press, `false` for release).
fn button_event(button: PointerFlags, down: bool, x: u16, y: u16) -> FastPathInputEvent {
    let mut flags = button;
    if down {
        flags |= PointerFlags::DOWN;
    }
    FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        number_of_wheel_rotation_units: 0,
        x_position: x,
        y_position: y,
    })
}

/// Translate a pointer state change into the RDP fast-path events needed to
/// reproduce it, diffing `buttons` against `prev_buttons`.
///
/// Emits a `MOVE` (so the server tracks the pointer) followed by a press/release
/// for every button whose state changed. Returns the events in send order.
pub fn pointer_events(prev_buttons: u8, buttons: u8, x: u32, y: u32) -> Vec<FastPathInputEvent> {
    let (px, py) = (clamp_pos(x), clamp_pos(y));
    let mut events = vec![move_event(px, py)];

    for (dom_bit, rdp_button) in [
        (DOM_LEFT, PointerFlags::LEFT_BUTTON),
        (DOM_RIGHT, PointerFlags::RIGHT_BUTTON),
        (DOM_MIDDLE, PointerFlags::MIDDLE_BUTTON_OR_WHEEL),
    ] {
        let was = prev_buttons & dom_bit != 0;
        let now = buttons & dom_bit != 0;
        if was != now {
            events.push(button_event(rdp_button, now, px, py));
        }
    }
    events
}

/// Translate a vertical scroll into an RDP wheel PDU, or `None` for a no-op.
///
/// Browser `deltaY > 0` scrolls the content down; RDP encodes wheel direction
/// with a signed rotation-units value and the `WHEEL_NEGATIVE` flag for the
/// downward (negative) direction.
pub fn wheel_event(x: u32, y: u32, delta_y: f64) -> Option<FastPathInputEvent> {
    if delta_y == 0.0 {
        return None;
    }
    let scroll_down = delta_y > 0.0;
    let mut flags = PointerFlags::VERTICAL_WHEEL;
    let units = if scroll_down {
        flags |= PointerFlags::WHEEL_NEGATIVE;
        -WHEEL_UNITS
    } else {
        WHEEL_UNITS
    };
    Some(FastPathInputEvent::MouseEvent(MousePdu {
        flags,
        number_of_wheel_rotation_units: units,
        x_position: clamp_pos(x),
        y_position: clamp_pos(y),
    }))
}

/// Translate a shared [`InputEvent`] into zero or more RDP fast-path events,
/// given the previous pointer-button mask (updated by the caller afterwards).
pub fn translate(prev_buttons: u8, event: &InputEvent) -> Vec<FastPathInputEvent> {
    match event {
        InputEvent::Key { code, pressed } => super::keymap::code_to_scancode(code)
            .map(|sc| vec![key_event(sc, *pressed)])
            .unwrap_or_default(),
        InputEvent::Pointer { x, y, buttons } => pointer_events(prev_buttons, *buttons, *x, *y),
        InputEvent::Wheel {
            x, y, delta_y, ..
        } => wheel_event(*x, *y, *delta_y).into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn as_mouse(ev: &FastPathInputEvent) -> &MousePdu {
        match ev {
            FastPathInputEvent::MouseEvent(m) => m,
            other => panic!("expected mouse event, got {other:?}"),
        }
    }

    #[test]
    fn key_press_and_release_flags() {
        let sc = Scancode {
            code: 0x1E,
            extended: false,
        };
        match key_event(sc, true) {
            FastPathInputEvent::KeyboardEvent(flags, code) => {
                assert_eq!(code, 0x1E);
                assert!(!flags.contains(KeyboardFlags::RELEASE));
                assert!(!flags.contains(KeyboardFlags::EXTENDED));
            }
            other => panic!("expected keyboard event, got {other:?}"),
        }
        match key_event(sc, false) {
            FastPathInputEvent::KeyboardEvent(flags, _) => {
                assert!(flags.contains(KeyboardFlags::RELEASE));
            }
            other => panic!("expected keyboard event, got {other:?}"),
        }
    }

    #[test]
    fn extended_key_sets_extended_flag() {
        let sc = Scancode {
            code: 0x1D,
            extended: true,
        };
        match key_event(sc, true) {
            FastPathInputEvent::KeyboardEvent(flags, _) => {
                assert!(flags.contains(KeyboardFlags::EXTENDED));
            }
            other => panic!("expected keyboard event, got {other:?}"),
        }
    }

    #[test]
    fn pointer_move_only_emits_single_move() {
        let events = pointer_events(0, 0, 100, 200);
        assert_eq!(events.len(), 1);
        let m = as_mouse(&events[0]);
        assert!(m.flags.contains(PointerFlags::MOVE));
        assert_eq!(m.x_position, 100);
        assert_eq!(m.y_position, 200);
    }

    #[test]
    fn left_button_press_then_release() {
        // 0 -> left down.
        let down = pointer_events(0, DOM_LEFT, 5, 6);
        assert_eq!(down.len(), 2); // move + press
        let press = as_mouse(&down[1]);
        assert!(press.flags.contains(PointerFlags::LEFT_BUTTON));
        assert!(press.flags.contains(PointerFlags::DOWN));

        // left held -> left up.
        let up = pointer_events(DOM_LEFT, 0, 5, 6);
        let release = as_mouse(&up[1]);
        assert!(release.flags.contains(PointerFlags::LEFT_BUTTON));
        assert!(!release.flags.contains(PointerFlags::DOWN));
    }

    #[test]
    fn right_and_middle_map_to_distinct_flags() {
        let r = pointer_events(0, DOM_RIGHT, 1, 1);
        assert!(as_mouse(&r[1]).flags.contains(PointerFlags::RIGHT_BUTTON));
        let m = pointer_events(0, DOM_MIDDLE, 1, 1);
        assert!(as_mouse(&m[1])
            .flags
            .contains(PointerFlags::MIDDLE_BUTTON_OR_WHEEL));
    }

    #[test]
    fn simultaneous_button_changes_all_emitted() {
        // No buttons -> left + right pressed together.
        let events = pointer_events(0, DOM_LEFT | DOM_RIGHT, 0, 0);
        // move + left press + right press.
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn wheel_up_and_down_directions() {
        let up = wheel_event(0, 0, -1.0).unwrap();
        let up = as_mouse(&up);
        assert!(up.flags.contains(PointerFlags::VERTICAL_WHEEL));
        assert!(!up.flags.contains(PointerFlags::WHEEL_NEGATIVE));
        assert!(up.number_of_wheel_rotation_units > 0);

        let down = wheel_event(0, 0, 1.0).unwrap();
        let down = as_mouse(&down);
        assert!(down.flags.contains(PointerFlags::WHEEL_NEGATIVE));
        assert!(down.number_of_wheel_rotation_units < 0);

        assert!(wheel_event(0, 0, 0.0).is_none());
    }

    #[test]
    fn coordinate_clamping_saturates_to_u16() {
        let events = pointer_events(0, 0, u32::MAX, u32::MAX);
        let m = as_mouse(&events[0]);
        assert_eq!(m.x_position, u16::MAX);
        assert_eq!(m.y_position, u16::MAX);
    }

    #[test]
    fn translate_unknown_key_is_empty() {
        let ev = InputEvent::Key {
            code: "Unidentified".to_string(),
            pressed: true,
        };
        assert!(translate(0, &ev).is_empty());
    }

    #[test]
    fn translate_known_key_maps() {
        let ev = InputEvent::Key {
            code: "KeyA".to_string(),
            pressed: true,
        };
        let events = translate(0, &ev);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], FastPathInputEvent::KeyboardEvent(..)));
    }
}
