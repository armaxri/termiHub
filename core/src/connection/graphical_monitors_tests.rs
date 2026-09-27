use super::*;

fn mon(x: i32, y: i32, width: u32, height: u32, primary: bool) -> MonitorRect {
    MonitorRect {
        primary,
        ..MonitorRect::new(x, y, width, height)
    }
}

#[test]
fn mode_parsing_defaults_to_single() {
    assert_eq!(MonitorMode::from_settings("", None), MonitorMode::Single);
    assert_eq!(
        MonitorMode::from_settings("bogus", Some(4)),
        MonitorMode::Single
    );
    assert_eq!(
        MonitorMode::from_settings("single", Some(4)),
        MonitorMode::Single
    );
    assert_eq!(
        MonitorMode::from_settings(" All ", None),
        MonitorMode::AllLocal
    );
    assert_eq!(
        MonitorMode::from_settings("custom", None),
        MonitorMode::Custom { count: 2 }
    );
    assert_eq!(
        MonitorMode::from_settings("custom", Some(1)),
        MonitorMode::Custom { count: 2 }
    );
    assert_eq!(
        MonitorMode::from_settings("custom", Some(200)),
        MonitorMode::Custom { count: 16 }
    );
    assert!(!MonitorMode::Single.is_multi());
    assert!(MonitorMode::AllLocal.is_multi());
}

#[test]
fn a_single_monitor_is_not_a_layout() {
    assert!(MonitorLayout::normalize(&[]).is_none());
    assert!(MonitorLayout::normalize(&[mon(0, 0, 1920, 1080, true)]).is_none());
    assert!(MonitorLayout::side_by_side(1, 1920, 1080).is_none());
}

#[test]
fn two_side_by_side_monitors_make_a_combined_desktop() {
    let layout =
        MonitorLayout::normalize(&[mon(0, 0, 1920, 1080, true), mon(1920, 0, 1280, 1024, false)])
            .expect("two monitors");
    assert_eq!(layout.desktop_size(), (3200, 1080));
    assert_eq!(
        layout.bounds(),
        LayoutBounds {
            x: 0,
            y: 0,
            width: 3200,
            height: 1080
        }
    );
    assert_eq!(layout.monitors()[1].x, 1920);
}

#[test]
fn the_primary_moves_to_the_origin_and_framebuffer_rects_are_zero_based() {
    // Secondary to the left of the primary, as on a real desk.
    let layout = MonitorLayout::normalize(&[
        mon(0, 0, 1280, 1024, false),
        mon(1280, 100, 1920, 1080, true),
    ])
    .expect("two monitors");
    let desktop = layout.monitors();
    assert_eq!((desktop[1].x, desktop[1].y), (0, 0));
    assert!(desktop[1].primary && !desktop[0].primary);
    assert_eq!((desktop[0].x, desktop[0].y), (-1280, -100));
    assert_eq!(layout.desktop_size(), (3200, 1180));

    let fb = layout.framebuffer_rects();
    assert_eq!((fb[0].x, fb[0].y, fb[0].width), (0, 0, 1280));
    assert_eq!((fb[1].x, fb[1].y, fb[1].width), (1280, 100, 1920));
}

#[test]
fn exactly_one_primary_is_kept() {
    let none =
        MonitorLayout::normalize(&[mon(0, 0, 800, 600, false), mon(800, 0, 800, 600, false)])
            .unwrap();
    assert_eq!(
        none.monitors()
            .iter()
            .map(|m| m.primary)
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    let both = MonitorLayout::normalize(&[mon(0, 0, 800, 600, true), mon(800, 0, 800, 600, true)])
        .unwrap();
    assert_eq!(both.monitors().iter().filter(|m| m.primary).count(), 1);
    assert!(both.monitors()[0].primary);
}

#[test]
fn sizes_and_scale_are_clamped_into_the_protocol_range() {
    let layout = MonitorLayout::normalize(&[
        MonitorRect {
            scale: 0,
            ..mon(0, 0, 1281, 50, true)
        },
        MonitorRect {
            scale: 900,
            ..mon(1281, 0, 1024, 768, false)
        },
    ])
    .unwrap();
    let m = layout.monitors();
    assert_eq!((m[0].width, m[0].height, m[0].scale), (1280, 200, 100));
    assert_eq!(m[1].scale, 500);
    // The clamped (narrower) primary left a gap, not an overlap: kept in place.
    assert_eq!(m[1].x, 1281);
}

#[test]
fn overlapping_monitors_are_laid_out_in_a_row() {
    // Mixed-DPI displays converted to logical pixels can overlap.
    let layout = MonitorLayout::normalize(&[
        mon(0, 0, 1728, 1117, true),
        mon(1500, -200, 2560, 1440, false),
    ])
    .unwrap();
    let m = layout.monitors();
    assert_eq!((m[0].x, m[0].y), (0, 0));
    assert_eq!((m[1].x, m[1].y), (1728, 0));
    assert_eq!(layout.desktop_size(), (4288, 1440));
}

#[test]
fn a_layout_larger_than_the_frame_bound_drops_trailing_monitors() {
    let rects: Vec<MonitorRect> = (0..5)
        .map(|i| mon(i * 2560, 0, 2560, 1440, i == 0))
        .collect();
    let layout = MonitorLayout::normalize(&rects).unwrap();
    // 3 x 2560 = 7680 fits 8192; a fourth would not.
    assert_eq!(layout.monitors().len(), 3);
    assert_eq!(layout.desktop_size(), (7680, 1440));
}

#[test]
fn at_most_sixteen_monitors_are_kept() {
    let rects: Vec<MonitorRect> = (0..20).map(|i| mon(i * 400, 0, 400, 300, i == 0)).collect();
    let layout = MonitorLayout::normalize(&rects).unwrap();
    assert_eq!(layout.monitors().len(), MAX_MONITORS);
}

#[test]
fn hostile_coordinates_never_overflow() {
    let layout = MonitorLayout::normalize(&[
        mon(i32::MIN, i32::MIN, u32::MAX, u32::MAX, true),
        mon(i32::MAX, i32::MAX, u32::MAX, u32::MAX, false),
    ]);
    // Two 8192-wide monitors can never share the 8192 bound.
    assert!(layout.is_none());
}

#[test]
fn side_by_side_builds_a_row_with_the_first_primary() {
    let layout = MonitorLayout::side_by_side(3, 1280, 800).unwrap();
    let m = layout.monitors();
    assert_eq!(m.len(), 3);
    assert!(m[0].primary);
    assert_eq!(
        m.iter().map(|m| m.x).collect::<Vec<_>>(),
        vec![0, 1280, 2560]
    );
    assert_eq!(layout.desktop_size(), (3840, 800));
}

#[test]
fn resolve_prefers_the_stamped_layout_and_falls_back_for_custom() {
    let stamped = [mon(0, 0, 1024, 768, true), mon(1024, 0, 1024, 768, false)];
    assert!(resolve_monitor_layout(MonitorMode::Single, &stamped, (1280, 800)).is_none());
    assert_eq!(
        resolve_monitor_layout(MonitorMode::AllLocal, &stamped, (1280, 800))
            .unwrap()
            .desktop_size(),
        (2048, 768)
    );
    // "All" without local display info stays single-monitor.
    assert!(resolve_monitor_layout(MonitorMode::AllLocal, &[], (1280, 800)).is_none());
    assert_eq!(
        resolve_monitor_layout(MonitorMode::Custom { count: 2 }, &[], (1280, 800))
            .unwrap()
            .desktop_size(),
        (2560, 800)
    );
}

#[test]
fn layout_parsing_is_lenient() {
    let value = serde_json::json!([
        { "x": 0, "y": 0, "width": 1920, "height": 1080, "primary": true, "scale": 100 },
        { "x": 1920, "y": 0, "width": 1920, "height": 1080 },
        { "x": "bad" },
        7
    ]);
    let rects = parse_monitor_rects(&value);
    assert_eq!(rects.len(), 2);
    assert!(rects[0].primary);
    assert_eq!(rects[1].scale, DEFAULT_MONITOR_SCALE);
    assert!(parse_monitor_rects(&serde_json::json!("nope")).is_empty());
}

#[test]
fn monitor_rect_serializes_camel_case() {
    let json = serde_json::to_value(mon(-5, 3, 800, 600, true)).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "x": -5, "y": 3, "width": 800, "height": 600, "primary": true, "scale": 100 })
    );
}

#[test]
fn multi_monitor_requested_reads_raw_settings() {
    assert!(multi_monitor_requested(
        &serde_json::json!({ "monitors": "all" })
    ));
    assert!(multi_monitor_requested(
        &serde_json::json!({ "monitors": "custom" })
    ));
    assert!(!multi_monitor_requested(
        &serde_json::json!({ "monitors": "single" })
    ));
    // Connections saved before #3696 carry no key at all.
    assert!(!multi_monitor_requested(
        &serde_json::json!({ "host": "h" })
    ));
}

#[test]
fn schema_rows_default_to_single_and_gate_the_count() {
    let fields = monitor_fields();
    let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, vec!["monitors", "monitorCount"]);
    assert_eq!(fields[0].default, Some(serde_json::json!("single")));
    let FieldType::Select { options } = &fields[0].field_type else {
        panic!("monitors must be a select");
    };
    let values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
    assert_eq!(values, vec!["single", "all", "custom"]);
    let cond = fields[1].visible_when.as_ref().expect("count is gated");
    assert_eq!(cond.field, "monitors");
    assert_eq!(cond.equals, serde_json::json!("custom"));
}

#[test]
fn capability_constructors() {
    assert_eq!(
        MultiMonitorCapability::supported(),
        MultiMonitorCapability {
            supported: true,
            max_monitors: 16
        }
    );
    assert_eq!(
        MultiMonitorCapability::default(),
        MultiMonitorCapability::unsupported()
    );
}

#[derive(serde::Deserialize)]
struct CountHolder {
    #[serde(default, deserialize_with = "deserialize_monitor_count")]
    count: Option<u8>,
}

#[test]
fn monitor_count_parsing_is_lenient() {
    let parse = |v: serde_json::Value| -> Option<u8> {
        serde_json::from_value::<CountHolder>(serde_json::json!({ "count": v }))
            .unwrap()
            .count
    };
    assert_eq!(parse(serde_json::json!(3)), Some(3));
    assert_eq!(parse(serde_json::json!(4.0)), Some(4));
    assert_eq!(parse(serde_json::json!("5")), Some(5));
    assert_eq!(parse(serde_json::json!(1000)), Some(255));
    assert_eq!(parse(serde_json::json!(-1)), None);
    assert_eq!(parse(serde_json::json!(null)), None);
    assert_eq!(parse(serde_json::json!("many")), None);
}
