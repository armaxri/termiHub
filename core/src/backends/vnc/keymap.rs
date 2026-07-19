//! Browser `KeyboardEvent.code` → X11 keysym mapping for RFB `KeyEvent`.
//!
//! The shared input pipeline (#1680) delivers keyboard input as protocol-agnostic
//! [`InputEvent::Key`](crate::connection::InputEvent::Key) events keyed by the
//! physical `KeyboardEvent.code` (`"KeyA"`, `"Enter"`, `"ControlLeft"`, …). The
//! RFB wire protocol ([RFC 6143 §7.5.4](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.5.4))
//! instead carries an **X11 keysym** (`u32`).
//!
//! This module maps the *physical* key to its *base* (unshifted) keysym. Shift,
//! Ctrl, Alt and Meta are themselves ordinary keys that travel as their own
//! `KeyEvent`s, so the server reconstructs shifted characters from the base key
//! plus a held modifier — exactly how a real VNC viewer behaves. Layout-aware
//! mapping (producing the shifted glyph directly) is intentionally out of scope;
//! see the follow-up noted on the PR.

/// Map a browser `KeyboardEvent.code` to its base X11 keysym.
///
/// Returns `None` for codes with no RFB-meaningful keysym; the caller drops
/// those rather than sending a bogus key.
pub fn code_to_keysym(code: &str) -> Option<u32> {
    // Letters — base (lowercase) keysym; Shift is sent as its own key.
    if let Some(rest) = code.strip_prefix("Key") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_uppercase() {
                // XK_a … XK_z == ASCII lowercase.
                return Some((c.to_ascii_lowercase()) as u32);
            }
        }
    }

    // Top-row digits — Digit0 … Digit9.
    if let Some(rest) = code.strip_prefix("Digit") {
        if rest.len() == 1 {
            let c = rest.as_bytes()[0];
            if c.is_ascii_digit() {
                return Some(c as u32); // XK_0 … XK_9 == ASCII digits.
            }
        }
    }

    // Numpad digits map to the same base digit keysyms (KP_0 exists but the
    // plain digit is universally accepted and simpler for typing).
    if let Some(rest) = code.strip_prefix("Numpad") {
        match rest {
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" => {
                return Some(rest.as_bytes()[0] as u32);
            }
            "Decimal" => return Some(0xFFAE),  // XK_KP_Decimal
            "Add" => return Some(0xFFAB),      // XK_KP_Add
            "Subtract" => return Some(0xFFAD), // XK_KP_Subtract
            "Multiply" => return Some(0xFFAA), // XK_KP_Multiply
            "Divide" => return Some(0xFFAF),   // XK_KP_Divide
            "Enter" => return Some(0xFF8D),    // XK_KP_Enter
            _ => {}
        }
    }

    // Function keys F1 … F12 → XK_F1 (0xFFBE) … XK_F12 (0xFFC9).
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=12).contains(&n) {
                return Some(0xFFBE + (n - 1));
            }
        }
    }

    let keysym = match code {
        // Whitespace / editing.
        "Space" => 0x20,       // XK_space
        "Enter" => 0xFF0D,     // XK_Return
        "Tab" => 0xFF09,       // XK_Tab
        "Backspace" => 0xFF08, // XK_BackSpace
        "Escape" => 0xFF1B,    // XK_Escape
        "Delete" => 0xFFFF,    // XK_Delete
        "Insert" => 0xFF63,    // XK_Insert

        // Navigation.
        "Home" => 0xFF50,       // XK_Home
        "End" => 0xFF57,        // XK_End
        "PageUp" => 0xFF55,     // XK_Prior
        "PageDown" => 0xFF56,   // XK_Next
        "ArrowLeft" => 0xFF51,  // XK_Left
        "ArrowUp" => 0xFF52,    // XK_Up
        "ArrowRight" => 0xFF53, // XK_Right
        "ArrowDown" => 0xFF54,  // XK_Down

        // Modifiers.
        "ShiftLeft" => 0xFFE1,             // XK_Shift_L
        "ShiftRight" => 0xFFE2,            // XK_Shift_R
        "ControlLeft" => 0xFFE3,           // XK_Control_L
        "ControlRight" => 0xFFE4,          // XK_Control_R
        "CapsLock" => 0xFFE5,              // XK_Caps_Lock
        "AltLeft" => 0xFFE9,               // XK_Alt_L
        "AltRight" => 0xFFEA,              // XK_Alt_R (AltGr)
        "MetaLeft" | "OSLeft" => 0xFFEB,   // XK_Super_L
        "MetaRight" | "OSRight" => 0xFFEC, // XK_Super_R
        "ContextMenu" => 0xFF67,           // XK_Menu

        // Punctuation — base (unshifted) glyph.
        "Minus" => 0x2D,        // -
        "Equal" => 0x3D,        // =
        "BracketLeft" => 0x5B,  // [
        "BracketRight" => 0x5D, // ]
        "Backslash" => 0x5C,    // \
        "Semicolon" => 0x3B,    // ;
        "Quote" => 0x27,        // '
        "Backquote" => 0x60,    // `
        "Comma" => 0x2C,        // ,
        "Period" => 0x2E,       // .
        "Slash" => 0x2F,        // /

        _ => return None,
    };
    Some(keysym)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_map_to_lowercase_ascii() {
        assert_eq!(code_to_keysym("KeyA"), Some(0x61));
        assert_eq!(code_to_keysym("KeyZ"), Some(0x7A));
        assert_eq!(code_to_keysym("KeyM"), Some('m' as u32));
    }

    #[test]
    fn digits_map_to_ascii() {
        assert_eq!(code_to_keysym("Digit0"), Some(0x30));
        assert_eq!(code_to_keysym("Digit9"), Some(0x39));
    }

    #[test]
    fn function_keys_span_f1_to_f12() {
        assert_eq!(code_to_keysym("F1"), Some(0xFFBE));
        assert_eq!(code_to_keysym("F12"), Some(0xFFC9));
        // F13 is not a standard function-key keysym in this table.
        assert_eq!(code_to_keysym("F13"), None);
    }

    #[test]
    fn control_keys_map() {
        assert_eq!(code_to_keysym("Enter"), Some(0xFF0D));
        assert_eq!(code_to_keysym("Escape"), Some(0xFF1B));
        assert_eq!(code_to_keysym("Backspace"), Some(0xFF08));
        assert_eq!(code_to_keysym("Tab"), Some(0xFF09));
        assert_eq!(code_to_keysym("Space"), Some(0x20));
        assert_eq!(code_to_keysym("Delete"), Some(0xFFFF));
    }

    #[test]
    fn ctrl_alt_del_components_all_map() {
        // The toolbar's Ctrl+Alt+Del sends three physical keys; every one must
        // resolve to a keysym or the sequence silently drops a key.
        assert!(code_to_keysym("ControlLeft").is_some());
        assert!(code_to_keysym("AltLeft").is_some());
        assert!(code_to_keysym("Delete").is_some());
    }

    #[test]
    fn modifiers_map() {
        assert_eq!(code_to_keysym("ShiftLeft"), Some(0xFFE1));
        assert_eq!(code_to_keysym("ControlRight"), Some(0xFFE4));
        assert_eq!(code_to_keysym("AltRight"), Some(0xFFEA));
        assert_eq!(code_to_keysym("MetaLeft"), Some(0xFFEB));
    }

    #[test]
    fn arrows_map() {
        assert_eq!(code_to_keysym("ArrowLeft"), Some(0xFF51));
        assert_eq!(code_to_keysym("ArrowUp"), Some(0xFF52));
        assert_eq!(code_to_keysym("ArrowRight"), Some(0xFF53));
        assert_eq!(code_to_keysym("ArrowDown"), Some(0xFF54));
    }

    #[test]
    fn numpad_maps() {
        assert_eq!(code_to_keysym("Numpad5"), Some(0x35));
        assert_eq!(code_to_keysym("NumpadEnter"), Some(0xFF8D));
        assert_eq!(code_to_keysym("NumpadAdd"), Some(0xFFAB));
    }

    #[test]
    fn punctuation_maps_to_base_glyph() {
        assert_eq!(code_to_keysym("Minus"), Some('-' as u32));
        assert_eq!(code_to_keysym("Slash"), Some('/' as u32));
        assert_eq!(code_to_keysym("Backquote"), Some('`' as u32));
    }

    #[test]
    fn unknown_codes_return_none() {
        assert_eq!(code_to_keysym(""), None);
        assert_eq!(code_to_keysym("Unidentified"), None);
        assert_eq!(code_to_keysym("KeyAB"), None);
        assert_eq!(code_to_keysym("Digit"), None);
    }
}
