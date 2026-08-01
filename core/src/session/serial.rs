//! Serial port session helpers shared between desktop and agent.
//!
//! Provides config parsing (string → `serial2` enums), async port opening,
//! and port listing. The [`Serial`](crate::backends::serial::Serial) backend
//! is the single canonical implementation used by both the desktop and agent.

use serial2_tokio::SerialPort;

use crate::config::SerialConfig;
use crate::errors::SessionError;

/// Pre-parsed serial port configuration.
///
/// Holds `serial2` enum values so they don't need to be re-parsed on every
/// reconnect attempt. Constructed via [`parse_serial_config`].
#[derive(Debug, Clone)]
pub struct ParsedSerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub char_size: serial2::CharSize,
    pub stop_bits: serial2::StopBits,
    pub parity: serial2::Parity,
    pub flow_control: serial2::FlowControl,
}

/// Parse a [`SerialConfig`] into a [`ParsedSerialConfig`] with validated
/// `serial2` enum values.
///
/// # Mapping rules
///
/// | Field          | Input                        | Output                              |
/// |----------------|------------------------------|-------------------------------------|
/// | `data_bits`    | 5, 6, 7, 8 (default 8)      | `CharSize::{Bits5..Bits8}`          |
/// | `stop_bits`    | 1, 2 (default 1)             | `StopBits::{One,Two}`               |
/// | `parity`       | "none","odd","even" (def.)   | `Parity::{None,Odd,Even}`           |
/// | `flow_control` | "none","hardware","software" | `FlowControl::{None,RtsCts,XonXoff}`|
///
/// Returns [`SessionError::InvalidConfig`] if the port name is empty.
pub fn parse_serial_config(config: &SerialConfig) -> Result<ParsedSerialConfig, SessionError> {
    if config.port.is_empty() {
        return Err(SessionError::InvalidConfig(
            "serial port name must not be empty".into(),
        ));
    }

    let char_size = match config.data_bits {
        5 => serial2::CharSize::Bits5,
        6 => serial2::CharSize::Bits6,
        7 => serial2::CharSize::Bits7,
        _ => serial2::CharSize::Bits8,
    };

    let stop_bits = match config.stop_bits {
        2 => serial2::StopBits::Two,
        _ => serial2::StopBits::One,
    };

    let parity = match config.parity.as_str() {
        "odd" => serial2::Parity::Odd,
        "even" => serial2::Parity::Even,
        _ => serial2::Parity::None,
    };

    let flow_control = match config.flow_control.as_str() {
        "hardware" => serial2::FlowControl::RtsCts,
        "software" => serial2::FlowControl::XonXoff,
        _ => serial2::FlowControl::None,
    };

    Ok(ParsedSerialConfig {
        port: config.port.clone(),
        baud_rate: config.baud_rate,
        char_size,
        stop_bits,
        parity,
        flow_control,
    })
}

/// Platform-appropriate remediation for a serial-port permission error.
///
/// Only Linux gates serial ports behind the `dialout` group, so the `usermod`
/// fix applies there alone. On Windows a denied `COM` port and on macOS a denied
/// `/dev/tty.*`/`/dev/cu.*` port almost always mean another program holds the
/// port or the user lacks access — there is no group to join, so we return plain
/// guidance rather than a bogus command (#1831). This runs on the machine that
/// owns the port (the host for local ports, the remote agent for agent-hosted
/// ports), so the advice matches where the device physically lives.
fn serial_permission_hint() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        "on Linux, add your user to the dialout group: sudo usermod -aG dialout $USER"
    }
    #[cfg(not(target_os = "linux"))]
    {
        "another application may be using the port, or you may not have permission to access it"
    }
}

/// Open a serial port using a pre-parsed configuration.
///
/// Returns a [`serial2_tokio::SerialPort`] ready for async I/O.
pub fn open_serial_port(config: &ParsedSerialConfig) -> Result<SerialPort, SessionError> {
    let baud_rate = config.baud_rate;
    let char_size = config.char_size;
    let stop_bits = config.stop_bits;
    let parity = config.parity;
    let flow_control = config.flow_control;

    SerialPort::open(&config.port, |mut settings: serial2::Settings| {
        settings.set_baud_rate(baud_rate)?;
        settings.set_char_size(char_size);
        settings.set_stop_bits(stop_bits);
        settings.set_parity(parity);
        settings.set_flow_control(flow_control);
        Ok(settings)
    })
    .map_err(|e| {
        let msg = match e.kind() {
            std::io::ErrorKind::NotFound => format!(
                "Serial port '{}' not found — check that the device is connected and the port name is correct",
                config.port
            ),
            std::io::ErrorKind::PermissionDenied => format!(
                "Permission denied on '{}' — {}",
                config.port,
                serial_permission_hint()
            ),
            _ => {
                let desc = e.to_string();
                if desc.contains("busy") || desc.contains("in use") || desc.contains("Access is denied") {
                    format!(
                        "Serial port '{}' is already in use by another application",
                        config.port
                    )
                } else if desc.contains("not found")
                    || desc.contains("cannot find")
                    || desc.contains("No such file")
                {
                    format!(
                        "Serial port '{}' not found — check that the device is connected and the port name is correct",
                        config.port
                    )
                } else {
                    format!("Failed to open serial port '{}': {}", config.port, e)
                }
            }
        };
        SessionError::SpawnFailed(msg)
    })
}

/// All built-in Linux `/dev` prefixes scanned to supplement `serial2`'s port enumeration.
///
/// Covers ARM SoC UARTs (PL011/PL010), NVIDIA Tegra/Jetson, NXP i.MX/LP-UART,
/// Xilinx Zynq, Qualcomm MSM/GENI, Amlogic, Samsung Exynos, Renesas, Marvell EBU,
/// STMicro, SiFive RISC-V, USB Gadget Serial, RPMsg co-processor TTYs, Bluetooth
/// RFCOMM, and a range of legacy embedded platforms.
pub const DEFAULT_EXTRA_LINUX_PREFIXES: &[&str] = &[
    // Common ARM / SBC UARTs
    "ttyAMA", // ARM PL011 UART (Raspberry Pi, most ARM SoCs)
    "ttyAM",  // ARM PL010 UART (older ARM boards)
    "ttyS",   // 8250/16550 standard PC UART
    // Generic udev symlinks
    "uart", "serial",
    // NVIDIA Tegra / Jetson
    "ttyTHS", // High-speed UART (Jetson Nano/TX1/TX2/Xavier/Orin)
    "ttyTCU", // Tegra combined UART
    // NXP / Freescale
    "ttymxc", // i.MX6/7/8 UART
    "ttyLP",  // LP-UART (i.MX7, i.MX8, Layerscape)
    // Xilinx / AMD
    "ttyPS", // Zynq / ZynqMP / Kria
    // Qualcomm
    "ttyMSM", // Legacy Snapdragon MSM UART
    "ttyHS",  // Snapdragon 845+ GENI UART
    // Amlogic
    "ttyAML", // S905/S922 (ODROID-C4/N2, VIM3)
    // Samsung
    "ttySAC", // Exynos
    // Renesas
    "ttySC", // SuperH / RZ / R-Car
    // Marvell
    "ttyMV", // EBU (Armada, Turris MOX, ESPRESSObin)
    // Qualcomm Atheros (OpenWrt routers)
    "ttyATH", // AR933x
    // STMicroelectronics
    "ttyAS", // STi SoCs (set-top boxes)
    // NXP automotive
    "ttyLF", // S32 / LinFlex UART
    // Microchip / Atmel
    "ttyAT", // AT91 / SAM series
    // SiFive RISC-V
    "ttySIF", // HiFive Unleashed, U74
    // Virtual / soft serial
    "ttyGS",    // USB Gadget Serial (device side, e.g. RPi Zero acting as USB gadget)
    "ttyRPMSG", // RPMsg TTY — co-processor IPC (STM32MP1, i.MX8, TI AM64x)
    // Bluetooth RFCOMM
    "rfcomm",
    // Legacy / less common platforms
    "ttyPSC", // Freescale MPC52xx / MPC512x (PowerPC)
    "ttyLTQ", // Lantiq XWAY (DSL gateway SoCs)
    "ttyTX",  // NXP LPC32xx
    "ttyAPP", // NXP MXS / i.MX28
    "ttyWMT", // VIA/WonderMedia (old Android tablets)
    "ttyCL",  // Cirrus Logic CLPS711x (ARM7 embedded)
    "ttySA",  // Intel StrongARM SA1100 (iPAQ era)
    "ttyPCH", // Intel Platform Controller Hub EG20T (Atom embedded)
    "ttyNVT", // Nuvoton MA35D1
    "ttyRDA", // RDA Micro 8810
    "ttyOWL", // Actions Semiconductor OWL
    "ttyLXU", // LiteX FPGA soft UART
    "ttyUSI", // Socionext Milbeaut
    "ttySUP", // Sunplus SP7021
    "ttyPIC", // Microchip PIC32 (MIPS)
    "ttyAL",  // Altera/Intel FPGA (NIOS II)
    "ttyHV",  // SPARC/Sun hypervisor serial
    "ttyB",   // HP PA-RISC serial mux
];

/// List available serial port names using all built-in prefixes.
///
/// Returns an empty vector if enumeration fails. On Linux, the result is
/// supplemented with a direct `/dev` scan using [`DEFAULT_EXTRA_LINUX_PREFIXES`]
/// for device patterns that `serial2` may not enumerate (e.g. ARM SoC UARTs).
pub fn list_serial_ports() -> Vec<String> {
    list_serial_ports_with_dev_and_prefixes(
        std::path::Path::new("/dev"),
        DEFAULT_EXTRA_LINUX_PREFIXES,
    )
}

/// List available serial ports using a caller-supplied set of Linux `/dev` prefixes.
///
/// Useful when the caller wants to respect a user-configured prefix list rather
/// than the built-in defaults. On non-Linux platforms the `enabled_prefixes`
/// argument is ignored.
pub fn list_serial_ports_with_enabled_prefixes(enabled_prefixes: &[&str]) -> Vec<String> {
    list_serial_ports_with_dev_and_prefixes(std::path::Path::new("/dev"), enabled_prefixes)
}

/// Inner implementation used by Linux tests to inject a custom `/dev` directory.
#[cfg(all(target_os = "linux", test))]
pub(crate) fn list_serial_ports_with_dev(dev_dir: &std::path::Path) -> Vec<String> {
    list_serial_ports_with_dev_and_prefixes(dev_dir, DEFAULT_EXTRA_LINUX_PREFIXES)
}

fn list_serial_ports_with_dev_and_prefixes(
    dev_dir: &std::path::Path,
    extra_prefixes: &[&str],
) -> Vec<String> {
    let crate_ports: Vec<String> = serial2::SerialPort::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    #[cfg(target_os = "linux")]
    {
        let mut ports = crate_ports;
        for extra in scan_extra_linux_serial_ports(dev_dir, extra_prefixes) {
            if !ports.contains(&extra) {
                ports.push(extra);
            }
        }
        ports.sort();
        ports
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (dev_dir, extra_prefixes);
        crate_ports
    }
}

/// Scan `dev_dir` for Linux UART devices not always enumerated by `serial2`
/// (e.g. PL011 UARTs on Raspberry Pi).
#[cfg(target_os = "linux")]
fn scan_extra_linux_serial_ports(dev_dir: &std::path::Path, prefixes: &[&str]) -> Vec<String> {
    let mut found = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dev_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if prefixes.iter().any(|prefix| name_str.starts_with(prefix)) {
                found.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(port: &str) -> SerialConfig {
        SerialConfig {
            port: port.to_string(),
            ..SerialConfig::default()
        }
    }

    /// Assert that parsing `config` fails with [`SessionError::InvalidConfig`].
    ///
    /// Used by the invalid-value rejection tests: for safety-critical serial
    /// hardware an out-of-range framing parameter must be surfaced as an error,
    /// never silently coerced to a default (see the doc comment on
    /// [`parse_serial_config`]).
    fn assert_rejected(config: &SerialConfig) {
        let result = parse_serial_config(config);
        assert!(
            matches!(result, Err(SessionError::InvalidConfig(_))),
            "expected InvalidConfig, got: {result:?}"
        );
    }

    #[test]
    fn parse_defaults() {
        let cfg = make_config("/dev/ttyUSB0");
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.port, "/dev/ttyUSB0");
        assert_eq!(parsed.baud_rate, 115200);
        assert_eq!(parsed.char_size, serial2::CharSize::Bits8);
        assert_eq!(parsed.stop_bits, serial2::StopBits::One);
        assert_eq!(parsed.parity, serial2::Parity::None);
        assert_eq!(parsed.flow_control, serial2::FlowControl::None);
    }

    #[test]
    fn parse_data_bits_five() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 5,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.char_size, serial2::CharSize::Bits5);
    }

    #[test]
    fn parse_data_bits_six() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 6,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.char_size, serial2::CharSize::Bits6);
    }

    #[test]
    fn parse_data_bits_seven() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 7,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.char_size, serial2::CharSize::Bits7);
    }

    #[test]
    fn parse_data_bits_eight() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 8,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.char_size, serial2::CharSize::Bits8);
    }

    #[test]
    fn parse_data_bits_out_of_range_rejected() {
        for bad in [0u8, 4, 9, 99] {
            assert_rejected(&SerialConfig {
                port: "COM1".into(),
                data_bits: bad,
                ..SerialConfig::default()
            });
        }
    }

    #[test]
    fn parse_stop_bits_one() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 1,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serial2::StopBits::One);
    }

    #[test]
    fn parse_stop_bits_two() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 2,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serial2::StopBits::Two);
    }

    #[test]
    fn parse_stop_bits_out_of_range_rejected() {
        for bad in [0u8, 3, 42] {
            assert_rejected(&SerialConfig {
                port: "COM1".into(),
                stop_bits: bad,
                ..SerialConfig::default()
            });
        }
    }

    #[test]
    fn parse_parity_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serial2::Parity::None);
    }

    #[test]
    fn parse_parity_odd() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "odd".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serial2::Parity::Odd);
    }

    #[test]
    fn parse_parity_even() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "even".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serial2::Parity::Even);
    }

    #[test]
    fn parse_parity_unknown_rejected() {
        for bad in ["mark", "space", "", "None", "ODD"] {
            assert_rejected(&SerialConfig {
                port: "COM1".into(),
                parity: bad.into(),
                ..SerialConfig::default()
            });
        }
    }

    #[test]
    fn parse_flow_control_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serial2::FlowControl::None);
    }

    #[test]
    fn parse_flow_control_hardware() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "hardware".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serial2::FlowControl::RtsCts);
    }

    #[test]
    fn parse_flow_control_software() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "software".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serial2::FlowControl::XonXoff);
    }

    #[test]
    fn parse_flow_control_unknown_rejected() {
        for bad in ["xonxoff", "rtscts", "", "Hardware"] {
            assert_rejected(&SerialConfig {
                port: "COM1".into(),
                flow_control: bad.into(),
                ..SerialConfig::default()
            });
        }
    }

    #[test]
    fn parse_baud_rate_zero_rejected() {
        assert_rejected(&SerialConfig {
            port: "COM1".into(),
            baud_rate: 0,
            ..SerialConfig::default()
        });
    }

    #[test]
    fn parse_non_standard_baud_rate_accepted() {
        // Baud rates beyond the UI dropdown (e.g. 230400, custom) are legitimate
        // on real hardware and must not be rejected — only 0 is invalid.
        for baud in [230400u32, 460800, 921600, 500_000] {
            let cfg = SerialConfig {
                port: "COM1".into(),
                baud_rate: baud,
                ..SerialConfig::default()
            };
            let parsed = parse_serial_config(&cfg).expect("non-standard baud must be accepted");
            assert_eq!(parsed.baud_rate, baud);
        }
    }

    #[test]
    fn parse_empty_port_returns_error() {
        let cfg = SerialConfig::default();
        let result = parse_serial_config(&cfg);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, SessionError::InvalidConfig(_)),
            "expected InvalidConfig, got: {:?}",
            err
        );
    }

    #[test]
    fn parse_custom_baud_rate() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            baud_rate: 9600,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.baud_rate, 9600);
    }

    #[test]
    fn parse_full_custom_config() {
        let cfg = SerialConfig {
            port: "/dev/ttyS0".into(),
            baud_rate: 9600,
            data_bits: 7,
            stop_bits: 2,
            parity: "even".into(),
            flow_control: "hardware".into(),
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.port, "/dev/ttyS0");
        assert_eq!(parsed.baud_rate, 9600);
        assert_eq!(parsed.char_size, serial2::CharSize::Bits7);
        assert_eq!(parsed.stop_bits, serial2::StopBits::Two);
        assert_eq!(parsed.parity, serial2::Parity::Even);
        assert_eq!(parsed.flow_control, serial2::FlowControl::RtsCts);
    }

    // --- list_serial_ports tests -----------------------------------------

    #[test]
    fn list_serial_ports_returns_vec() {
        let ports = list_serial_ports();
        assert!(ports.len() < 10_000, "sanity check on port count");
    }

    // --- scan_extra_linux_serial_ports / list_serial_ports_with_dev (Linux) -

    #[cfg(target_os = "linux")]
    mod linux_extra_scan {
        use super::*;
        use std::fs;
        use tempfile::TempDir;

        fn make_dev_entries(dir: &std::path::Path, names: &[&str]) {
            for name in names {
                fs::write(dir.join(name), b"").unwrap();
            }
        }

        #[test]
        fn scan_finds_ttyama_devices() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["ttyAMA1", "ttyAMA2", "tty", "random"]);
            let mut found = scan_extra_linux_serial_ports(dir.path(), DEFAULT_EXTRA_LINUX_PREFIXES);
            found.sort();
            assert!(found.iter().any(|p| p.ends_with("ttyAMA1")));
            assert!(found.iter().any(|p| p.ends_with("ttyAMA2")));
            assert!(!found.iter().any(|p| p.ends_with("/tty")));
        }

        #[test]
        fn scan_finds_ttys_devices() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["ttyS0", "ttyS1"]);
            let found = scan_extra_linux_serial_ports(dir.path(), DEFAULT_EXTRA_LINUX_PREFIXES);
            assert!(found.iter().any(|p| p.ends_with("ttyS0")));
            assert!(found.iter().any(|p| p.ends_with("ttyS1")));
        }

        #[test]
        fn scan_finds_uart_devices() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["uart0", "uart1"]);
            let found = scan_extra_linux_serial_ports(dir.path(), DEFAULT_EXTRA_LINUX_PREFIXES);
            assert!(found.iter().any(|p| p.ends_with("uart0")));
            assert!(found.iter().any(|p| p.ends_with("uart1")));
        }

        #[test]
        fn scan_finds_serial_devices() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["serial0", "serial1"]);
            let found = scan_extra_linux_serial_ports(dir.path(), DEFAULT_EXTRA_LINUX_PREFIXES);
            assert!(found.iter().any(|p| p.ends_with("serial0")));
            assert!(found.iter().any(|p| p.ends_with("serial1")));
        }

        #[test]
        fn scan_does_not_include_unrelated_devices() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["ttyUSB0", "ttyACM0", "tty", "null", "zero"]);
            let found = scan_extra_linux_serial_ports(dir.path(), DEFAULT_EXTRA_LINUX_PREFIXES);
            assert!(found.is_empty());
        }

        #[test]
        fn scan_handles_missing_directory_gracefully() {
            let path = std::path::Path::new("/nonexistent/dev/termiHub_test");
            let found = scan_extra_linux_serial_ports(path, DEFAULT_EXTRA_LINUX_PREFIXES);
            assert!(found.is_empty());
        }

        #[test]
        fn list_serial_ports_with_dev_includes_extra_linux_ports() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["ttyAMA1", "ttyS0", "uart0", "serial0"]);
            let ports = list_serial_ports_with_dev(dir.path());
            assert!(ports.iter().any(|p| p.ends_with("ttyAMA1")));
            assert!(ports.iter().any(|p| p.ends_with("ttyS0")));
            assert!(ports.iter().any(|p| p.ends_with("uart0")));
            assert!(ports.iter().any(|p| p.ends_with("serial0")));
        }

        #[test]
        fn list_serial_ports_with_dev_deduplicates_ports() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(dir.path(), &["ttyAMA1"]);
            let ports = list_serial_ports_with_dev(dir.path());
            let count = ports.iter().filter(|p| p.ends_with("ttyAMA1")).count();
            assert_eq!(count, 1, "ttyAMA1 must not appear twice");
        }

        #[test]
        fn list_serial_ports_with_dev_output_is_sorted() {
            let dir = TempDir::new().unwrap();
            make_dev_entries(
                dir.path(),
                &["ttyS2", "ttyAMA1", "uart0", "serial0", "ttyS0"],
            );
            let ports = list_serial_ports_with_dev(dir.path());
            let mut sorted = ports.clone();
            sorted.sort();
            assert_eq!(ports, sorted, "ports should be sorted alphabetically");
        }
    }

    // --- open_serial_port tests ------------------------------------------

    #[test]
    fn open_invalid_port_returns_spawn_failed() {
        let parsed = ParsedSerialConfig {
            port: "/dev/__nonexistent_serial_port__".into(),
            baud_rate: 115200,
            char_size: serial2::CharSize::Bits8,
            stop_bits: serial2::StopBits::One,
            parity: serial2::Parity::None,
            flow_control: serial2::FlowControl::None,
        };
        let result = open_serial_port(&parsed);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, SessionError::SpawnFailed(_)),
            "expected SpawnFailed, got: {:?}",
            err
        );
    }

    // --- serial_permission_hint tests ------------------------------------
    //
    // The permission-error remediation must be host-OS specific: the Linux
    // `dialout` advice is wrong on Windows/macOS, where there is no such group
    // (#1831). CI runs on all three platforms, so each leg pins its own case.

    #[cfg(target_os = "linux")]
    #[test]
    fn permission_hint_mentions_dialout_on_linux() {
        assert!(
            serial_permission_hint().contains("dialout"),
            "Linux hint should recommend the dialout group, got: {:?}",
            serial_permission_hint()
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn permission_hint_omits_dialout_off_linux() {
        let hint = serial_permission_hint();
        assert!(
            !hint.contains("dialout"),
            "non-Linux hint must not mention the dialout group, got: {hint:?}"
        );
        assert!(
            !hint.is_empty(),
            "non-Linux hint should still offer generic guidance"
        );
    }
}
