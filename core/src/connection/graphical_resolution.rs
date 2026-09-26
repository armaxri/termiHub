//! User-selectable remote resolution for graphical remote-desktop sessions
//! (PROD-026).
//!
//! A graphical connection either follows the window (**dynamic**, the default
//! and the pre-PROD-026 behavior: the remote starts at the backend's default
//! size and, in "Match Window" scale mode, is asked to resize as the tab
//! resizes) or is pinned to a **fixed** `width × height` chosen in the editor.
//! A fixed session never requests a desktop-size change — the frontend scales
//! the canvas locally instead, the desktop's session manager refuses resize
//! requests for it, and an auto-reconnect re-dials with the same fixed size.
//!
//! The mode key and the fixed-size rows are protocol-agnostic so any backend
//! that can honor a requested size can append them to its **Display** group;
//! today only RDP does (vnc-rs has no client-initiated `SetDesktopSize`).

use super::schema::{Condition, FieldType, SelectOption, SettingsField};
use super::MAX_FRAMEBUFFER_DIMENSION;

/// Settings key of the resolution-mode select.
pub const RESOLUTION_MODE_KEY: &str = "resolutionMode";
/// Resolution mode: follow the window (default, pre-PROD-026 behavior).
pub const RESOLUTION_MODE_DYNAMIC: &str = "dynamic";
/// Resolution mode: pin the remote to the configured `width × height`.
pub const RESOLUTION_MODE_FIXED: &str = "fixed";

/// Smallest fixed dimension accepted, in pixels — the MS-RDPEDISP lower bound,
/// below which servers reject or misrender a desktop.
pub const MIN_FIXED_DIMENSION: u16 = 200;
/// Largest fixed dimension accepted, in pixels — the shared frame bound every
/// graphical frame is checked against ([`MAX_FRAMEBUFFER_DIMENSION`]).
// The shared bound is 8192, which always fits a u16.
pub const MAX_FIXED_DIMENSION: u16 = MAX_FRAMEBUFFER_DIMENSION as u16;

/// Default fixed width pre-filled in the editor when the user picks "Fixed".
pub const DEFAULT_FIXED_WIDTH: u16 = 1920;
/// Default fixed height pre-filled in the editor when the user picks "Fixed".
pub const DEFAULT_FIXED_HEIGHT: u16 = 1080;

/// Whether `mode` (a resolution-mode select value) selects a fixed resolution.
/// Anything other than `"fixed"` — including empty / unknown / absent — is
/// dynamic, so connections saved before PROD-026 keep their behavior.
pub fn is_fixed_mode(mode: &str) -> bool {
    mode.trim().eq_ignore_ascii_case(RESOLUTION_MODE_FIXED)
}

/// Whether raw connection `settings` request a fixed remote resolution.
///
/// Protocol-agnostic: the desktop's graphical session manager uses it to
/// refuse resize requests for a fixed session regardless of backend.
pub fn fixed_resolution_requested(settings: &serde_json::Value) -> bool {
    settings
        .get(RESOLUTION_MODE_KEY)
        .and_then(|v| v.as_str())
        .is_some_and(is_fixed_mode)
}

/// Normalize a user-entered fixed size into the range every graphical backend
/// accepts: each dimension clamped to
/// [`MIN_FIXED_DIMENSION`]`..=`[`MAX_FIXED_DIMENSION`], and the width rounded
/// down to an even number (MS-RDPEDISP forbids odd widths; RDP servers round
/// odd widths anyway, which would make the framebuffer disagree with the
/// requested size).
pub fn normalize_fixed_size(width: u16, height: u16) -> (u16, u16) {
    let w = width.clamp(MIN_FIXED_DIMENSION, MAX_FIXED_DIMENSION) & !1;
    let h = height.clamp(MIN_FIXED_DIMENSION, MAX_FIXED_DIMENSION);
    (w, h)
}

fn when_fixed() -> Option<Condition> {
    Some(Condition {
        field: RESOLUTION_MODE_KEY.to_string(),
        equals: serde_json::json!(RESOLUTION_MODE_FIXED),
    })
}

fn size_field(key: &str, label: &str, default: u16, description: &str) -> SettingsField {
    SettingsField {
        key: key.to_string(),
        label: label.to_string(),
        description: Some(description.to_string()),
        help_text: None,
        field_type: FieldType::Number {
            min: Some(f64::from(MIN_FIXED_DIMENSION)),
            max: Some(f64::from(MAX_FIXED_DIMENSION)),
        },
        required: false,
        default: Some(serde_json::json!(default)),
        placeholder: Some(default.to_string()),
        supports_env_expansion: false,
        supports_tilde_expansion: false,
        visible_when: when_fixed(),
    }
}

/// The resolution rows a size-capable backend appends to its **Display**
/// group: the mode select plus the fixed `width` / `height` inputs, which are
/// shown only when "Fixed" is selected.
pub fn fixed_resolution_fields() -> Vec<SettingsField> {
    vec![
        SettingsField {
            key: RESOLUTION_MODE_KEY.to_string(),
            label: "Resolution".to_string(),
            description: Some(
                "Dynamic follows the tab (the remote resizes in Match Window scaling). Fixed \
                 pins the remote desktop to the size below and scales it locally."
                    .to_string(),
            ),
            help_text: None,
            field_type: FieldType::Select {
                options: vec![
                    SelectOption {
                        value: RESOLUTION_MODE_DYNAMIC.to_string(),
                        label: "Dynamic (follow window)".to_string(),
                    },
                    SelectOption {
                        value: RESOLUTION_MODE_FIXED.to_string(),
                        label: "Fixed size".to_string(),
                    },
                ],
            },
            required: false,
            default: Some(serde_json::json!(RESOLUTION_MODE_DYNAMIC)),
            placeholder: None,
            supports_env_expansion: false,
            supports_tilde_expansion: false,
            visible_when: None,
        },
        size_field(
            "width",
            "Width (px)",
            DEFAULT_FIXED_WIDTH,
            "Remote desktop width, 200–8192 pixels. Odd widths are rounded down to even.",
        ),
        size_field(
            "height",
            "Height (px)",
            DEFAULT_FIXED_HEIGHT,
            "Remote desktop height, 200–8192 pixels.",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parsing_defaults_to_dynamic() {
        assert!(is_fixed_mode("fixed"));
        assert!(is_fixed_mode(" Fixed "));
        assert!(!is_fixed_mode("dynamic"));
        assert!(!is_fixed_mode(""));
        assert!(!is_fixed_mode("bogus"));
    }

    #[test]
    fn fixed_requested_reads_raw_settings() {
        assert!(fixed_resolution_requested(
            &serde_json::json!({ "resolutionMode": "fixed" })
        ));
        assert!(!fixed_resolution_requested(
            &serde_json::json!({ "resolutionMode": "dynamic" })
        ));
        // Pre-PROD-026 configs carry no mode at all → dynamic.
        assert!(!fixed_resolution_requested(
            &serde_json::json!({ "host": "h" })
        ));
        assert!(!fixed_resolution_requested(
            &serde_json::json!({ "resolutionMode": 1 })
        ));
    }

    #[test]
    fn normalize_clamps_and_evens_width() {
        assert_eq!(normalize_fixed_size(1920, 1080), (1920, 1080));
        assert_eq!(normalize_fixed_size(1281, 801), (1280, 801));
        assert_eq!(normalize_fixed_size(10, 0), (200, 200));
        assert_eq!(normalize_fixed_size(u16::MAX, u16::MAX), (8192, 8192));
    }

    #[test]
    fn schema_rows_are_bounded_and_gated_on_fixed() {
        let fields = fixed_resolution_fields();
        let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["resolutionMode", "width", "height"]);
        assert_eq!(fields[0].default, Some(serde_json::json!("dynamic")));
        assert!(fields[0].visible_when.is_none());
        for f in &fields[1..] {
            match &f.field_type {
                FieldType::Number { min, max } => {
                    assert_eq!(*min, Some(200.0));
                    assert_eq!(*max, Some(f64::from(MAX_FRAMEBUFFER_DIMENSION)));
                }
                other => panic!("{} should be a number field, got {other:?}", f.key),
            }
            let cond = f.visible_when.as_ref().expect("size rows are gated");
            assert_eq!(cond.field, "resolutionMode");
            assert_eq!(cond.equals, serde_json::json!("fixed"));
        }
    }
}
