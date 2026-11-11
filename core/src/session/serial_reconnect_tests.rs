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
