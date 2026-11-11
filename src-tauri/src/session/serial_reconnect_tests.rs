//! Tests for the serial auto-reconnect gate (#5390). A fake probe stands in for
//! the machine's ports; no real serial device is touched.

use std::collections::BTreeMap;

use serde_json::json;

use super::*;

/// Port name → identity (`None` = present but unidentified).
struct FakePorts(BTreeMap<String, Option<SerialDeviceIdentity>>);

impl FakePorts {
    fn new(ports: &[(&str, Option<SerialDeviceIdentity>)]) -> Self {
        Self(
            ports
                .iter()
                .map(|(p, i)| (p.to_string(), i.clone()))
                .collect(),
        )
    }
}

impl SerialPortProbe for FakePorts {
    fn port_present(&self, port: &str) -> bool {
        self.0.contains_key(port)
    }
    fn list_ports(&self) -> Vec<String> {
        self.0.keys().cloned().collect()
    }
    fn identity(&self, port: &str) -> Option<SerialDeviceIdentity> {
        self.0.get(port).cloned().flatten()
    }
}

fn adapter(serial: &str) -> SerialDeviceIdentity {
    SerialDeviceIdentity {
        vendor_id: "0403".to_string(),
        product_id: "6001".to_string(),
        serial_number: Some(serial.to_string()),
    }
}

fn serial_settings(port: &str) -> Value {
    json!({ "port": port, "baudRate": "9600", "parity": "even", "dataBits": "7" })
}

#[test]
fn identity_is_recorded_only_for_direct_serial() {
    let ports = FakePorts::new(&[("/dev/ttyUSB0", Some(adapter("A1")))]);
    let settings = serial_settings("/dev/ttyUSB0");
    assert_eq!(
        opened_serial_identity("serial", None, &settings, &ports),
        Some(adapter("A1"))
    );
    assert_eq!(
        opened_serial_identity("serial", Some("agent-1"), &settings, &ports),
        None
    );
    assert_eq!(
        opened_serial_identity("telnet", None, &settings, &ports),
        None
    );
}

#[test]
fn non_serial_and_agent_requests_pass_through() {
    let ports = FakePorts::new(&[]);
    let ssh = json!({ "host": "h" });
    assert_eq!(
        gate_serial_reconnect("ssh", None, ssh.clone(), None, &ports),
        Ok(ssh)
    );
    let agent_serial = serial_settings("/dev/ttyUSB0");
    assert_eq!(
        gate_serial_reconnect("serial", Some("a"), agent_serial.clone(), None, &ports),
        Ok(agent_serial)
    );
}

#[test]
fn absent_port_is_a_failed_attempt_with_a_reason() {
    let ports = FakePorts::new(&[]);
    let err = gate_serial_reconnect(
        "serial",
        None,
        serial_settings("/dev/ttyUSB0"),
        Some(&adapter("A1")),
        &ports,
    )
    .unwrap_err();
    assert!(err.contains("/dev/ttyUSB0"), "{err}");
    assert!(err.contains("not present"), "{err}");
}

#[test]
fn returning_device_reopens_with_the_saved_line_settings() {
    let ports = FakePorts::new(&[("/dev/ttyUSB0", Some(adapter("A1")))]);
    let settings = serial_settings("/dev/ttyUSB0");
    assert_eq!(
        gate_serial_reconnect(
            "serial",
            None,
            settings.clone(),
            Some(&adapter("A1")),
            &ports
        ),
        Ok(settings)
    );
}

#[test]
fn a_different_device_on_the_name_is_not_opened() {
    let ports = FakePorts::new(&[("COM3", Some(adapter("B2")))]);
    let err = gate_serial_reconnect(
        "serial",
        None,
        serial_settings("COM3"),
        Some(&adapter("A1")),
        &ports,
    )
    .unwrap_err();
    assert!(err.contains("different device"), "{err}");
}

#[test]
fn a_renamed_device_reopens_under_its_new_name_keeping_line_settings() {
    let ports = FakePorts::new(&[("/dev/ttyUSB1", Some(adapter("A1")))]);
    let got = gate_serial_reconnect(
        "serial",
        None,
        serial_settings("/dev/ttyUSB0"),
        Some(&adapter("A1")),
        &ports,
    )
    .unwrap();
    assert_eq!(got["port"], "/dev/ttyUSB1");
    assert_eq!(got["baudRate"], "9600");
    assert_eq!(got["parity"], "even");
    assert_eq!(got["dataBits"], "7");
}
