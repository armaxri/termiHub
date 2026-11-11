//! Serial auto-reconnect: decide which port, if any, to reopen (#5390).
//!
//! When a serial port drops (a USB adapter is unplugged or re-enumerates), the
//! backend reconnect loop retries on the shared policy. Before each attempt it
//! asks [`resolve_reconnect_port`] whether the device the user configured is
//! back. Only a `Reopen` answer opens anything; every other answer counts as a
//! failed attempt, so the loop backs off and gives up after the policy's limit.
//!
//! # Identity
//!
//! The configured port path (or COM name) is the persisted identifier. When the
//! platform can read a USB identity for the port ([`SerialDeviceIdentity`]:
//! vendor id, product id and serial number), the loop remembers the identity of
//! the device that was open before the drop and:
//!
//! - reopens the configured name only when the device on it has the **same**
//!   identity — a different adapter plugged into the same name is never opened;
//! - follows a rename (the OS gave the device a new tty / COM name) only when
//!   the remembered identity has a serial number and exactly one present port
//!   carries that full identity. Vendor and product id alone are not unique, so
//!   they never move the session to another name.
//!
//! Without a remembered identity (a non-USB port, or a platform that cannot read
//! it) the loop reopens the configured name once it exists again, and nothing
//! else. It never opens a port the user did not configure.
//!
//! The identity is read from sysfs on Linux. macOS and Windows report none yet,
//! so they rely on the configured name alone.

use serde::{Deserialize, Serialize};

/// The USB identity of the device behind a serial port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialDeviceIdentity {
    /// USB vendor id, as four lowercase hex digits (e.g. `0403`).
    pub vendor_id: String,
    /// USB product id, as four lowercase hex digits (e.g. `6001`).
    pub product_id: String,
    /// The USB serial number, when the device reports one.
    pub serial_number: Option<String>,
}

impl SerialDeviceIdentity {
    /// Whether this identity names one physical device: it has a non-empty
    /// serial number. Only such an identity may follow a renamed port.
    pub fn is_unique(&self) -> bool {
        self.serial_number
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    }

    /// A short human-readable form, e.g. `USB 0403:6001 (serial A10K3Z)`.
    pub fn describe(&self) -> String {
        match self.serial_number.as_deref().filter(|s| !s.is_empty()) {
            Some(serial) => format!(
                "USB {}:{} (serial {serial})",
                self.vendor_id, self.product_id
            ),
            None => format!("USB {}:{}", self.vendor_id, self.product_id),
        }
    }
}

/// What the reconnect loop can see of the machine's serial ports. The
/// production probe is [`SystemSerialPortProbe`]; tests use a fake so no real
/// device is ever touched.
pub trait SerialPortProbe: Send + Sync {
    /// Whether the port `port` currently exists.
    fn port_present(&self, port: &str) -> bool;
    /// Every serial port currently present.
    fn list_ports(&self) -> Vec<String>;
    /// The USB identity of the device behind `port`, if it can be read.
    fn identity(&self, port: &str) -> Option<SerialDeviceIdentity>;
}

/// The answer to "may the reconnect loop open a port now?".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconnectPortResolution {
    /// Open this port. It is the configured name, or the name the same device
    /// (matched by its full identity) now carries.
    Reopen {
        /// The port to open.
        port: String,
    },
    /// The configured port is not present. Keep waiting.
    Absent,
    /// The configured port is present, but its device cannot be identified
    /// yet, while the device that was open before the drop could be. Keep
    /// waiting; never open an unverified device.
    Unverified,
    /// A different device is on the configured name. It is not opened.
    DifferentDevice {
        /// The identity of the device now on the configured name.
        found: SerialDeviceIdentity,
    },
}

impl ReconnectPortResolution {
    /// The reason a non-`Reopen` resolution did not open the port, phrased for
    /// the reconnect overlay. `None` for [`ReconnectPortResolution::Reopen`].
    pub fn waiting_reason(&self, configured: &str) -> Option<String> {
        match self {
            Self::Reopen { .. } => None,
            Self::Absent => Some(format!("Serial port {configured} is not present.")),
            Self::Unverified => Some(format!(
                "Serial port {configured} is back, but its device could not be identified yet."
            )),
            Self::DifferentDevice { found } => Some(format!(
                "A different device ({}) is on {configured}. It was not opened.",
                found.describe()
            )),
        }
    }
}

/// Decide which port the serial reconnect loop may open (see the module docs).
///
/// `configured` is the port the connection names; `remembered` is the identity
/// of the device that was open before the drop, if one was read.
pub fn resolve_reconnect_port(
    configured: &str,
    remembered: Option<&SerialDeviceIdentity>,
    probe: &dyn SerialPortProbe,
) -> ReconnectPortResolution {
    let present = probe.port_present(configured);
    let Some(remembered) = remembered else {
        return if present {
            ReconnectPortResolution::Reopen {
                port: configured.to_string(),
            }
        } else {
            ReconnectPortResolution::Absent
        };
    };

    let on_configured = present.then(|| probe.identity(configured));
    if let Some(Some(found)) = &on_configured {
        if found == remembered {
            return ReconnectPortResolution::Reopen {
                port: configured.to_string(),
            };
        }
    }

    // The configured name is gone or holds another device. Follow the device
    // to a new name only when its identity is unique and exactly one port has it.
    if remembered.is_unique() {
        let mut matches = probe
            .list_ports()
            .into_iter()
            .filter(|p| p != configured)
            .filter(|p| probe.identity(p).as_ref() == Some(remembered));
        if let (Some(port), None) = (matches.next(), matches.next()) {
            return ReconnectPortResolution::Reopen { port };
        }
    }

    match on_configured {
        None => ReconnectPortResolution::Absent,
        Some(None) => ReconnectPortResolution::Unverified,
        Some(Some(found)) => ReconnectPortResolution::DifferentDevice { found },
    }
}

/// The production [`SerialPortProbe`]: the real port list, and the USB identity
/// from sysfs on Linux (none elsewhere yet).
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemSerialPortProbe;

impl SerialPortProbe for SystemSerialPortProbe {
    fn port_present(&self, port: &str) -> bool {
        if cfg!(windows) {
            // COM names are not filesystem paths; ask the port enumeration.
            self.list_ports()
                .iter()
                .any(|p| p.eq_ignore_ascii_case(port))
        } else {
            std::path::Path::new(port).exists()
        }
    }

    fn list_ports(&self) -> Vec<String> {
        super::serial::list_serial_ports()
    }

    fn identity(&self, port: &str) -> Option<SerialDeviceIdentity> {
        platform_usb_identity(port)
    }
}

/// The USB identity of `port` from sysfs: resolve `/dev/serial/by-id/…` links
/// to the tty, then read its USB ancestor.
#[cfg(target_os = "linux")]
fn platform_usb_identity(port: &str) -> Option<SerialDeviceIdentity> {
    let real = std::fs::canonicalize(port).ok()?;
    let tty = real.file_name()?.to_str()?;
    usb_identity_from_sysfs(std::path::Path::new("/sys/class/tty"), tty)
}

/// No USB identity is read on this platform yet; the loop matches the port
/// name only.
#[cfg(not(target_os = "linux"))]
fn platform_usb_identity(_port: &str) -> Option<SerialDeviceIdentity> {
    None
}

/// Read the USB identity of tty `tty` from a sysfs `class/tty` directory: walk
/// up from the tty's device to the first ancestor with `idVendor` and
/// `idProduct`, and read its optional `serial`.
#[cfg(target_os = "linux")]
pub(crate) fn usb_identity_from_sysfs(
    class_tty: &std::path::Path,
    tty: &str,
) -> Option<SerialDeviceIdentity> {
    fn read_trimmed(path: &std::path::Path) -> Option<String> {
        let raw = std::fs::read_to_string(path).ok()?;
        let value = raw.trim();
        (!value.is_empty()).then(|| value.to_ascii_lowercase())
    }

    let device = std::fs::canonicalize(class_tty.join(tty).join("device")).ok()?;
    let mut dir = Some(device.as_path());
    while let Some(d) = dir {
        if let (Some(vendor_id), Some(product_id)) = (
            read_trimmed(&d.join("idVendor")),
            read_trimmed(&d.join("idProduct")),
        ) {
            // The serial number is case-sensitive; keep it as reported.
            let serial_number = std::fs::read_to_string(d.join("serial"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Some(SerialDeviceIdentity {
                vendor_id,
                product_id,
                serial_number,
            });
        }
        dir = d.parent();
    }
    None
}

#[cfg(test)]
#[path = "serial_reconnect_tests.rs"]
mod tests;
