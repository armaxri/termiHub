//! Browser `KeyboardEvent.code` → RDP (PC/AT scancode **set 1**) mapping.
//!
//! The shared input pipeline (#1680) delivers keyboard input as protocol-agnostic
//! [`InputEvent::Key`](termihub_core::connection::InputEvent::Key) events keyed by the
//! physical `KeyboardEvent.code` (`"KeyA"`, `"Enter"`, `"ControlLeft"`, …). The
//! RDP wire protocol carries a **PC/AT scancode** (set 1 "make" code) plus an
//! *extended* flag for the E0-prefixed keys (arrows, right-hand modifiers, the
//! numpad enter/slash, nav cluster). This module maps physical key → scancode.
//!
//! Like the VNC keymap, this maps the *physical* key only: Shift/Ctrl/Alt travel
//! as their own key events and the server reconstructs shifted glyphs from the
//! base key plus the held modifier — exactly how a real RDP client behaves.
//! Layout-aware mapping is intentionally out of scope (see the PR follow-up).

/// A resolved RDP scancode: the set-1 make code plus whether it is an extended
/// (E0-prefixed) key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scancode {
    /// PC/AT scancode set 1 make code (low byte).
    pub code: u16,
    /// Whether this is an extended (E0) key.
    pub extended: bool,
}

impl Scancode {
    const fn plain(code: u16) -> Self {
        Self {
            code,
            extended: false,
        }
    }

    const fn ext(code: u16) -> Self {
        Self {
            code,
            extended: true,
        }
    }
}

/// Map a browser `KeyboardEvent.code` to its RDP scancode-set-1 make code.
///
/// Returns `None` for codes with no RDP-meaningful scancode; the caller drops
/// those rather than sending a bogus key.
pub fn code_to_scancode(code: &str) -> Option<Scancode> {
    // Letters — QWERTY physical positions, set-1 make codes.
    if let Some(rest) = code.strip_prefix("Key") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_uppercase() {
                return letter_scancode(c).map(Scancode::plain);
            }
        }
    }

    // Top-row digits Digit1..Digit9 → 0x02..0x0A, Digit0 → 0x0B.
    if let Some(rest) = code.strip_prefix("Digit") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_digit() {
                let n = (c - b'0') as u16;
                let sc = if n == 0 { 0x0B } else { 0x01 + n };
                return Some(Scancode::plain(sc));
            }
        }
    }

    // Function keys F1..F12.
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u16>() {
            return match n {
                1..=10 => Some(Scancode::plain(0x3B + (n - 1))),
                11 => Some(Scancode::plain(0x57)),
                12 => Some(Scancode::plain(0x58)),
                _ => None,
            };
        }
    }

    // Numpad.
    if let Some(rest) = code.strip_prefix("Numpad") {
        return match rest {
            "0" => Some(Scancode::plain(0x52)),
            "1" => Some(Scancode::plain(0x4F)),
            "2" => Some(Scancode::plain(0x50)),
            "3" => Some(Scancode::plain(0x51)),
            "4" => Some(Scancode::plain(0x4B)),
            "5" => Some(Scancode::plain(0x4C)),
            "6" => Some(Scancode::plain(0x4D)),
            "7" => Some(Scancode::plain(0x47)),
            "8" => Some(Scancode::plain(0x48)),
            "9" => Some(Scancode::plain(0x49)),
            "Decimal" => Some(Scancode::plain(0x53)),
            "Add" => Some(Scancode::plain(0x4E)),
            "Subtract" => Some(Scancode::plain(0x4A)),
            "Multiply" => Some(Scancode::plain(0x37)),
            // Numpad divide and enter are E0-extended.
            "Divide" => Some(Scancode::ext(0x35)),
            "Enter" => Some(Scancode::ext(0x1C)),
            _ => None,
        };
    }

    Some(match code {
        // Whitespace / editing.
        "Space" => Scancode::plain(0x39),
        "Enter" => Scancode::plain(0x1C),
        "Tab" => Scancode::plain(0x0F),
        "Backspace" => Scancode::plain(0x0E),
        "Escape" => Scancode::plain(0x01),

        // Extended nav / editing cluster (E0-prefixed).
        "Insert" => Scancode::ext(0x52),
        "Delete" => Scancode::ext(0x53),
        "Home" => Scancode::ext(0x47),
        "End" => Scancode::ext(0x4F),
        "PageUp" => Scancode::ext(0x49),
        "PageDown" => Scancode::ext(0x51),
        "ArrowLeft" => Scancode::ext(0x4B),
        "ArrowUp" => Scancode::ext(0x48),
        "ArrowRight" => Scancode::ext(0x4D),
        "ArrowDown" => Scancode::ext(0x50),

        // Modifiers — left is plain, right is extended.
        "ShiftLeft" => Scancode::plain(0x2A),
        "ShiftRight" => Scancode::plain(0x36),
        "ControlLeft" => Scancode::plain(0x1D),
        "ControlRight" => Scancode::ext(0x1D),
        "AltLeft" => Scancode::plain(0x38),
        "AltRight" => Scancode::ext(0x38),
        "CapsLock" => Scancode::plain(0x3A),
        "NumLock" => Scancode::plain(0x45),
        "ScrollLock" => Scancode::plain(0x46),
        "MetaLeft" | "OSLeft" => Scancode::ext(0x5B),
        "MetaRight" | "OSRight" => Scancode::ext(0x5C),
        "ContextMenu" => Scancode::ext(0x5D),

        // Punctuation — physical positions, set-1 make codes.
        "Minus" => Scancode::plain(0x0C),
        "Equal" => Scancode::plain(0x0D),
        "BracketLeft" => Scancode::plain(0x1A),
        "BracketRight" => Scancode::plain(0x1B),
        "Backslash" => Scancode::plain(0x2B),
        "Semicolon" => Scancode::plain(0x27),
        "Quote" => Scancode::plain(0x28),
        "Backquote" => Scancode::plain(0x29),
        "Comma" => Scancode::plain(0x33),
        "Period" => Scancode::plain(0x34),
        "Slash" => Scancode::plain(0x35),
        "IntlBackslash" => Scancode::plain(0x56),

        _ => return None,
    })
}

/// Set-1 make code for a `KeyA`..`KeyZ` uppercase ASCII byte, following the
/// physical QWERTY layout (not alphabetical order).
fn letter_scancode(c: u8) -> Option<u16> {
    let sc = match c {
        b'Q' => 0x10,
        b'W' => 0x11,
        b'E' => 0x12,
        b'R' => 0x13,
        b'T' => 0x14,
        b'Y' => 0x15,
        b'U' => 0x16,
        b'I' => 0x17,
        b'O' => 0x18,
        b'P' => 0x19,
        b'A' => 0x1E,
        b'S' => 0x1F,
        b'D' => 0x20,
        b'F' => 0x21,
        b'G' => 0x22,
        b'H' => 0x23,
        b'J' => 0x24,
        b'K' => 0x25,
        b'L' => 0x26,
        b'Z' => 0x2C,
        b'X' => 0x2D,
        b'C' => 0x2E,
        b'V' => 0x2F,
        b'B' => 0x30,
        b'N' => 0x31,
        b'M' => 0x32,
        _ => return None,
    };
    Some(sc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_use_physical_layout_positions() {
        assert_eq!(code_to_scancode("KeyQ"), Some(Scancode::plain(0x10)));
        assert_eq!(code_to_scancode("KeyA"), Some(Scancode::plain(0x1E)));
        assert_eq!(code_to_scancode("KeyZ"), Some(Scancode::plain(0x2C)));
        assert_eq!(code_to_scancode("KeyM"), Some(Scancode::plain(0x32)));
    }

    #[test]
    fn digits_map_to_top_row() {
        assert_eq!(code_to_scancode("Digit1"), Some(Scancode::plain(0x02)));
        assert_eq!(code_to_scancode("Digit9"), Some(Scancode::plain(0x0A)));
        assert_eq!(code_to_scancode("Digit0"), Some(Scancode::plain(0x0B)));
    }

    #[test]
    fn function_keys_span_f1_to_f12() {
        assert_eq!(code_to_scancode("F1"), Some(Scancode::plain(0x3B)));
        assert_eq!(code_to_scancode("F10"), Some(Scancode::plain(0x44)));
        assert_eq!(code_to_scancode("F11"), Some(Scancode::plain(0x57)));
        assert_eq!(code_to_scancode("F12"), Some(Scancode::plain(0x58)));
        assert_eq!(code_to_scancode("F13"), None);
    }

    #[test]
    fn control_keys_map() {
        assert_eq!(code_to_scancode("Enter"), Some(Scancode::plain(0x1C)));
        assert_eq!(code_to_scancode("Escape"), Some(Scancode::plain(0x01)));
        assert_eq!(code_to_scancode("Backspace"), Some(Scancode::plain(0x0E)));
        assert_eq!(code_to_scancode("Tab"), Some(Scancode::plain(0x0F)));
        assert_eq!(code_to_scancode("Space"), Some(Scancode::plain(0x39)));
    }

    #[test]
    fn ctrl_alt_del_components_all_map() {
        // The toolbar's Ctrl+Alt+Del must resolve every physical key or the
        // sequence silently drops one.
        assert_eq!(code_to_scancode("ControlLeft"), Some(Scancode::plain(0x1D)));
        assert_eq!(code_to_scancode("AltLeft"), Some(Scancode::plain(0x38)));
        // Delete is in the extended nav cluster.
        assert_eq!(code_to_scancode("Delete"), Some(Scancode::ext(0x53)));
    }

    #[test]
    fn right_modifiers_and_nav_are_extended() {
        assert_eq!(code_to_scancode("ControlRight"), Some(Scancode::ext(0x1D)));
        assert_eq!(code_to_scancode("AltRight"), Some(Scancode::ext(0x38)));
        assert_eq!(code_to_scancode("ArrowUp"), Some(Scancode::ext(0x48)));
        assert_eq!(code_to_scancode("ArrowLeft"), Some(Scancode::ext(0x4B)));
        assert_eq!(code_to_scancode("Home"), Some(Scancode::ext(0x47)));
        assert_eq!(code_to_scancode("MetaLeft"), Some(Scancode::ext(0x5B)));
    }

    #[test]
    fn numpad_maps_with_extended_enter_and_divide() {
        assert_eq!(code_to_scancode("Numpad5"), Some(Scancode::plain(0x4C)));
        assert_eq!(code_to_scancode("Numpad0"), Some(Scancode::plain(0x52)));
        assert_eq!(code_to_scancode("NumpadAdd"), Some(Scancode::plain(0x4E)));
        assert_eq!(code_to_scancode("NumpadEnter"), Some(Scancode::ext(0x1C)));
        assert_eq!(code_to_scancode("NumpadDivide"), Some(Scancode::ext(0x35)));
    }

    #[test]
    fn punctuation_maps_to_physical_positions() {
        assert_eq!(code_to_scancode("Minus"), Some(Scancode::plain(0x0C)));
        assert_eq!(code_to_scancode("Slash"), Some(Scancode::plain(0x35)));
        assert_eq!(code_to_scancode("Backquote"), Some(Scancode::plain(0x29)));
    }

    #[test]
    fn unknown_codes_return_none() {
        assert_eq!(code_to_scancode(""), None);
        assert_eq!(code_to_scancode("Unidentified"), None);
        assert_eq!(code_to_scancode("KeyAB"), None);
        assert_eq!(code_to_scancode("Digit"), None);
    }
}
