//! Tests for the serial auto-reconnect port resolution (#5390). Every test uses
//! a fake [`SerialPortProbe`]; no real serial device is opened or enumerated.

use std::collections::BTreeMap;
use std::sync::Mutex;

use super::*;
use crate::reconnect_backoff::{
    reconnect_reducer, ReconnectEvent, ReconnectPhase, ReconnectState, RECONNECT_POLICY,
};

/// A fake set of serial ports: name → identity (`None` = present, unidentified).
#[derive(Default)]
struct FakePorts {
    ports: Mutex<BTreeMap<String, Option<SerialDeviceIdentity>>>,
}

impl FakePorts {
    fn plug(&self, port: &str, identity: Option<SerialDeviceIdentity>) {
        self.ports
            .lock()
            .unwrap()
            .insert(port.to_string(), identity);
    }

    fn unplug(&self, port: &str) {
        self.ports.lock().unwrap().remove(port);
    }
}

impl SerialPortProbe for FakePorts {
    fn port_present(&self, port: &str) -> bool {
        self.ports.lock().unwrap().contains_key(port)
    }

    fn list_ports(&self) -> Vec<String> {
        self.ports.lock().unwrap().keys().cloned().collect()
    }

    fn identity(&self, port: &str) -> Option<SerialDeviceIdentity> {
        self.ports.lock().unwrap().get(port).cloned().flatten()
    }
}

fn ftdi(serial: Option<&str>) -> SerialDeviceIdentity {
    SerialDeviceIdentity {
        vendor_id: "0403".to_string(),
        product_id: "6001".to_string(),
        serial_number: serial.map(str::to_string),
    }
}

fn ch340() -> SerialDeviceIdentity {
    SerialDeviceIdentity {
        vendor_id: "1a86".to_string(),
        product_id: "7523".to_string(),
        serial_number: None,
    }
}

fn reopen(port: &str) -> ReconnectPortResolution {
    ReconnectPortResolution::Reopen {
        port: port.to_string(),
    }
}

#[test]
fn no_remembered_identity_reopens_only_the_configured_name() {
    let ports = FakePorts::default();
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", None, &ports),
        ReconnectPortResolution::Absent
    );
    // Another port appearing is never opened.
    ports.plug("/dev/ttyUSB1", Some(ftdi(Some("A1"))));
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", None, &ports),
        ReconnectPortResolution::Absent
    );
    ports.plug("/dev/ttyUSB0", None);
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", None, &ports),
        reopen("/dev/ttyUSB0")
    );
}

#[test]
fn same_device_on_the_configured_name_is_reopened() {
    let ports = FakePorts::default();
    ports.plug("COM3", Some(ftdi(Some("A1"))));
    assert_eq!(
        resolve_reconnect_port("COM3", Some(&ftdi(Some("A1"))), &ports),
        reopen("COM3")
    );
}

#[test]
fn a_different_device_on_the_configured_name_is_not_opened() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB0", Some(ch340()));
    let got = resolve_reconnect_port("/dev/ttyUSB0", Some(&ftdi(Some("A1"))), &ports);
    assert_eq!(
        got,
        ReconnectPortResolution::DifferentDevice { found: ch340() }
    );
    let reason = got.waiting_reason("/dev/ttyUSB0").unwrap();
    assert!(reason.contains("1a86:7523"), "{reason}");
    assert!(reason.contains("not opened"), "{reason}");
}

#[test]
fn same_model_with_another_serial_number_is_a_different_device() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB0", Some(ftdi(Some("B2"))));
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", Some(&ftdi(Some("A1"))), &ports),
        ReconnectPortResolution::DifferentDevice {
            found: ftdi(Some("B2"))
        }
    );
}

#[test]
fn an_unidentifiable_device_is_not_opened_when_the_original_was_identified() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB0", None);
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", Some(&ftdi(Some("A1"))), &ports),
        ReconnectPortResolution::Unverified
    );
}

#[test]
fn a_renamed_device_with_a_serial_number_is_followed() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB1", Some(ftdi(Some("A1"))));
    ports.plug("/dev/ttyUSB2", Some(ftdi(Some("B2"))));
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", Some(&ftdi(Some("A1"))), &ports),
        reopen("/dev/ttyUSB1")
    );
}

#[test]
fn a_rename_is_not_followed_without_a_serial_number() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB1", Some(ch340()));
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", Some(&ch340()), &ports),
        ReconnectPortResolution::Absent
    );
}

#[test]
fn an_ambiguous_rename_is_not_followed() {
    let ports = FakePorts::default();
    ports.plug("/dev/ttyUSB1", Some(ftdi(Some("A1"))));
    ports.plug("/dev/ttyUSB2", Some(ftdi(Some("A1"))));
    assert_eq!(
        resolve_reconnect_port("/dev/ttyUSB0", Some(&ftdi(Some("A1"))), &ports),
        ReconnectPortResolution::Absent
    );
}

#[test]
fn identity_describe_and_uniqueness() {
    assert!(ftdi(Some("A1")).is_unique());
    assert!(!ftdi(Some("  ")).is_unique());
    assert!(!ch340().is_unique());
    assert_eq!(ftdi(Some("A1")).describe(), "USB 0403:6001 (serial A1)");
    assert_eq!(ch340().describe(), "USB 1a86:7523");
    assert_eq!(reopen("x").waiting_reason("x"), None);
}

/// The full drop → absent → wrong device → reappear → reopen cycle, driven
/// through the shared reconnect reducer exactly as the backend redrive does:
/// a non-`Reopen` resolution is a failed attempt, a `Reopen` one succeeds.
#[test]
fn drop_reappear_reopen_cycle_with_a_fake_port() {
    let ports = FakePorts::default();
    let original = ftdi(Some("A1"));
    ports.plug("/dev/ttyUSB0", Some(original.clone()));
    let mut rand = || 0.0;
    let policy = RECONNECT_POLICY;

    // The adapter drops.
    ports.unplug("/dev/ttyUSB0");
    let mut state = reconnect_reducer(
        &ReconnectState::default(),
        ReconnectEvent::Drop,
        &policy,
        &mut rand,
    );
    assert_eq!(state.phase, ReconnectPhase::Waiting);

    let mut attempt = |state: &ReconnectState, ports: &FakePorts| {
        let s = reconnect_reducer(state, ReconnectEvent::Attempt, &policy, &mut rand);
        let resolution = resolve_reconnect_port("/dev/ttyUSB0", Some(&original), ports);
        let event = match resolution {
            ReconnectPortResolution::Reopen { .. } => ReconnectEvent::Success,
            _ => ReconnectEvent::Failure,
        };
        (reconnect_reducer(&s, event, &policy, &mut rand), resolution)
    };

    // Still unplugged: the attempt fails and the loop backs off.
    let (next, res) = attempt(&state, &ports);
    assert_eq!(res, ReconnectPortResolution::Absent);
    assert_eq!(next.phase, ReconnectPhase::Waiting);
    state = next;

    // Another adapter grabs the name: not opened, still waiting.
    ports.plug("/dev/ttyUSB0", Some(ch340()));
    let (next, res) = attempt(&state, &ports);
    assert!(matches!(
        res,
        ReconnectPortResolution::DifferentDevice { .. }
    ));
    assert_eq!(next.phase, ReconnectPhase::Waiting);
    state = next;

    // The original adapter is back on its name: reopened, loop settles.
    ports.unplug("/dev/ttyUSB0");
    ports.plug("/dev/ttyUSB0", Some(original.clone()));
    let (next, res) = attempt(&state, &ports);
    assert_eq!(res, reopen("/dev/ttyUSB0"));
    assert_eq!(next.phase, ReconnectPhase::Connected);
}

/// A port that never comes back gives up after the shared policy's limit.
#[test]
fn a_port_that_never_returns_gives_up_after_the_policy_limit() {
    let ports = FakePorts::default();
    let mut rand = || 0.0;
    let policy = RECONNECT_POLICY;
    let mut state = reconnect_reducer(
        &ReconnectState::default(),
        ReconnectEvent::Drop,
        &policy,
        &mut rand,
    );
    let mut attempts = 0;
    while state.phase == ReconnectPhase::Waiting {
        state = reconnect_reducer(&state, ReconnectEvent::Attempt, &policy, &mut rand);
        attempts += 1;
        assert_eq!(
            resolve_reconnect_port("/dev/ttyUSB0", None, &ports),
            ReconnectPortResolution::Absent
        );
        state = reconnect_reducer(&state, ReconnectEvent::Failure, &policy, &mut rand);
    }
    assert_eq!(state.phase, ReconnectPhase::Gaveup);
    assert_eq!(attempts, policy.max_attempts);
}

#[cfg(target_os = "linux")]
#[test]
fn sysfs_identity_walks_up_to_the_usb_device() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let usb = root.path().join("devices/usb1/1-1");
    let iface = usb.join("1-1:1.0/ttyUSB0");
    std::fs::create_dir_all(&iface).unwrap();
    std::fs::write(usb.join("idVendor"), "0403\n").unwrap();
    std::fs::write(usb.join("idProduct"), "6001\n").unwrap();
    std::fs::write(usb.join("serial"), "A10K3Z\n").unwrap();
    let class_tty = root.path().join("class/tty");
    std::fs::create_dir_all(class_tty.join("ttyUSB0")).unwrap();
    symlink(&iface, class_tty.join("ttyUSB0/device")).unwrap();

    assert_eq!(
        usb_identity_from_sysfs(&class_tty, "ttyUSB0"),
        Some(SerialDeviceIdentity {
            vendor_id: "0403".to_string(),
            product_id: "6001".to_string(),
            serial_number: Some("A10K3Z".to_string()),
        })
    );
    assert_eq!(usb_identity_from_sysfs(&class_tty, "ttyS0"), None);
}

// --- macOS and Windows port names (#5394) ---

#[test]
fn macos_style_names_match_by_identity() {
    let ports = FakePorts::default();
    let configured = "/dev/cu.usbserial-A10K3Z";
    let original = ftdi(Some("A10K3Z"));
    // A different FTDI adapter (another serial) under the configured name.
    ports.plug(configured, Some(ftdi(Some("B20L4Y"))));
    assert_eq!(
        resolve_reconnect_port(configured, Some(&original), &ports),
        ReconnectPortResolution::DifferentDevice {
            found: ftdi(Some("B20L4Y"))
        }
    );
    // The dial-in twin of the configured device is not a rename target for it:
    // only the full identity may move the session, and it is not present.
    ports.plug("/dev/tty.usbserial-B20L4Y", Some(ftdi(Some("B20L4Y"))));
    assert!(matches!(
        resolve_reconnect_port(configured, Some(&original), &ports),
        ReconnectPortResolution::DifferentDevice { .. }
    ));
    // The original adapter is back under its own name.
    ports.unplug("/dev/tty.usbserial-B20L4Y");
    ports.plug(configured, Some(original.clone()));
    assert_eq!(
        resolve_reconnect_port(configured, Some(&original), &ports),
        reopen(configured)
    );
}

#[test]
fn macos_style_rename_is_followed_only_with_a_unique_serial() {
    let ports = FakePorts::default();
    let original = ftdi(Some("A10K3Z"));
    // macOS lists the callout and dial-in device of one adapter; following a
    // rename must pick exactly one name. A pair of names with the same identity
    // is ambiguous, so the session does not move.
    ports.plug("/dev/cu.usbserial-1420", Some(original.clone()));
    ports.plug("/dev/tty.usbserial-1420", Some(original.clone()));
    assert_eq!(
        resolve_reconnect_port("/dev/cu.usbserial-1410", Some(&original), &ports),
        ReconnectPortResolution::Absent
    );
    ports.unplug("/dev/tty.usbserial-1420");
    assert_eq!(
        resolve_reconnect_port("/dev/cu.usbserial-1410", Some(&original), &ports),
        reopen("/dev/cu.usbserial-1420")
    );
    // Without a serial number nothing moves.
    let anon = ch340();
    ports.plug("/dev/cu.wchusbserial1420", Some(anon.clone()));
    assert_eq!(
        resolve_reconnect_port("/dev/cu.wchusbserial1410", Some(&anon), &ports),
        ReconnectPortResolution::Absent
    );
}

#[test]
fn windows_style_names_match_by_identity() {
    let ports = FakePorts::default();
    let original = ftdi(Some("A10K3Z"));
    // A CH340 got COM3 after the FTDI adapter was unplugged: not opened.
    ports.plug("COM3", Some(ch340()));
    assert_eq!(
        resolve_reconnect_port("COM3", Some(&original), &ports),
        ReconnectPortResolution::DifferentDevice { found: ch340() }
    );
    // The FTDI adapter came back as COM7: followed by its serial number.
    ports.plug("COM7", Some(original.clone()));
    assert_eq!(
        resolve_reconnect_port("COM3", Some(&original), &ports),
        reopen("COM7")
    );
    // COM3 present but unidentifiable while the original could be identified.
    ports.unplug("COM7");
    ports.plug("COM3", None);
    assert_eq!(
        resolve_reconnect_port("COM3", Some(&original), &ports),
        ReconnectPortResolution::Unverified
    );
    ports.plug("COM3", Some(original.clone()));
    assert_eq!(
        resolve_reconnect_port("COM3", Some(&original), &ports),
        reopen("COM3")
    );
}

#[test]
fn from_usb_ids_is_the_canonical_form() {
    assert_eq!(
        SerialDeviceIdentity::from_usb_ids(0x0403, 0x6001, Some(" A10K3Z ")),
        ftdi(Some("A10K3Z"))
    );
    assert_eq!(
        SerialDeviceIdentity::from_usb_ids(0x1A86, 0x7523, Some("")),
        ch340()
    );
    assert_eq!(
        SerialDeviceIdentity::from_usb_ids(0x1a86, 0x7523, None),
        ch340()
    );
}

#[test]
fn windows_device_id_of_a_usb_device_with_a_serial_number() {
    assert_eq!(
        usb_identity_from_windows_device_id(r"USB\VID_0403&PID_6001\A10K3Z"),
        Some(ftdi(Some("A10K3Z")))
    );
    // Lowercase / mixed-case ids parse to the same canonical identity.
    assert_eq!(
        usb_identity_from_windows_device_id(r"usb\vid_0403&pid_6001\A10K3Z"),
        Some(ftdi(Some("A10K3Z")))
    );
}

#[test]
fn windows_device_id_with_a_generated_instance_id_has_no_serial() {
    assert_eq!(
        usb_identity_from_windows_device_id(r"USB\VID_1A86&PID_7523\5&2F1B3C4D&0&2"),
        Some(ch340())
    );
}

#[test]
fn windows_device_ids_that_are_not_a_whole_usb_device_are_skipped() {
    for id in [
        // One interface of a composite device; its parent is the device.
        r"USB\VID_2341&PID_0043&MI_00\6&1234ABCD&0&0000",
        // FTDI's vendor bus below the USB device.
        r"FTDIBUS\VID_0403+PID_6001+A10K3ZA\0000",
        // A legacy on-board port.
        r"ACPI\PNP0501\1",
        r"USB\ROOT_HUB30\4&1A2B3C4D&0&0",
        // Malformed ids.
        r"USB\VID_0403\A10K3Z",
        r"USB\VID_04031&PID_6001\A10K3Z",
        r"USB\VID_XYZW&PID_6001\A10K3Z",
        r"USB\VID_0403&PID_6001",
        r"USB\VID_0403&PID_6001\A\B",
        "",
    ] {
        assert_eq!(usb_identity_from_windows_device_id(id), None, "{id}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn macos_reader_has_no_identity_for_a_missing_port() {
    assert_eq!(
        SystemSerialPortProbe.identity("/dev/cu.termihub-no-such-port-5394"),
        None
    );
}

/// The IOKit enumeration reads every port's device files (only lists, never
/// opens): each callout / dial-in name it reports exists under `/dev`.
#[cfg(target_os = "macos")]
#[test]
fn macos_registry_names_existing_device_files() {
    for port in macos_usb::serial_ports() {
        for name in [&port.callout, &port.dialin].into_iter().flatten() {
            assert!(name.starts_with("/dev/"), "{name}");
            assert!(std::path::Path::new(name).exists(), "{name}");
        }
    }
}

#[cfg(windows)]
#[test]
fn windows_reader_has_no_identity_for_a_missing_port() {
    assert_eq!(SystemSerialPortProbe.identity("COM255"), None);
}

/// Manual sanity check of the platform reader (#5394): list every serial port
/// with its USB identity. It only enumerates; no port is opened. Run with
/// `cargo test -p termihub-core --features serial -- --ignored --nocapture
/// list_serial_ports_with_usb_identity`.
#[test]
#[ignore = "manual: lists the machine's real serial ports"]
fn list_serial_ports_with_usb_identity() {
    let probe = SystemSerialPortProbe;
    for port in probe.list_ports() {
        let identity = probe.identity(&port);
        println!(
            "{port}: {}",
            identity.map_or_else(|| "no USB identity".to_string(), |i| i.describe())
        );
    }
}
