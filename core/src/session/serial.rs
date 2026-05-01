//! Serial port session helpers shared between desktop and agent.
//!
//! Provides config parsing (string → `serialport` enums), port opening,
//! port listing, and a reconnect-capable reader loop. Both the desktop
//! backend (`src-tauri/src/terminal/serial.rs`) and the agent backend
//! (`agent/src/serial/backend.rs`) delegate to these helpers so the
//! logic lives in one place.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::buffer::RingBuffer;
use crate::config::SerialConfig;
use crate::errors::SessionError;

/// Pre-parsed serial port configuration cached for reconnection.
///
/// Holds `serialport` enum values so they don't need to be re-parsed
/// on every reconnect attempt. Constructed via [`parse_serial_config`].
#[derive(Debug, Clone)]
pub struct ParsedSerialConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: serialport::DataBits,
    pub stop_bits: serialport::StopBits,
    pub parity: serialport::Parity,
    pub flow_control: serialport::FlowControl,
}

/// Parse a [`SerialConfig`] into a [`ParsedSerialConfig`] with validated
/// `serialport` enum values.
///
/// # Mapping rules
///
/// | Field          | Input                      | Output                          |
/// |----------------|----------------------------|---------------------------------|
/// | `data_bits`    | 5, 6, 7, 8 (default 8)    | `DataBits::{Five..Eight}`       |
/// | `stop_bits`    | 1, 2 (default 1)           | `StopBits::{One,Two}`           |
/// | `parity`       | "none","odd","even" (def.) | `Parity::{None,Odd,Even}`       |
/// | `flow_control` | "none","hardware","software" (def.) | `FlowControl::{None,Hardware,Software}` |
///
/// Returns [`SessionError::InvalidConfig`] if the port name is empty.
pub fn parse_serial_config(config: &SerialConfig) -> Result<ParsedSerialConfig, SessionError> {
    if config.port.is_empty() {
        return Err(SessionError::InvalidConfig(
            "serial port name must not be empty".into(),
        ));
    }

    let data_bits = match config.data_bits {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    };

    let stop_bits = match config.stop_bits {
        2 => serialport::StopBits::Two,
        _ => serialport::StopBits::One,
    };

    let parity = match config.parity.as_str() {
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    };

    let flow_control = match config.flow_control.as_str() {
        "hardware" => serialport::FlowControl::Hardware,
        "software" => serialport::FlowControl::Software,
        _ => serialport::FlowControl::None,
    };

    Ok(ParsedSerialConfig {
        port: config.port.clone(),
        baud_rate: config.baud_rate,
        data_bits,
        stop_bits,
        parity,
        flow_control,
    })
}

/// Open a serial port using a pre-parsed configuration.
///
/// The port is opened with a 100 ms read timeout, matching both
/// the desktop and agent implementations.
pub fn open_serial_port(
    config: &ParsedSerialConfig,
) -> Result<Box<dyn serialport::SerialPort>, SessionError> {
    serialport::new(&config.port, config.baud_rate)
        .data_bits(config.data_bits)
        .stop_bits(config.stop_bits)
        .parity(config.parity)
        .flow_control(config.flow_control)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| {
            let msg = match e.kind() {
                serialport::ErrorKind::Io(std::io::ErrorKind::NotFound) => format!(
                    "Serial port '{}' not found — check that the device is connected and the port name is correct",
                    config.port
                ),
                serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => format!(
                    "Permission denied on '{}' — on Linux, add your user to the dialout group: sudo usermod -aG dialout $USER",
                    config.port
                ),
                _ => {
                    let desc = e.to_string();
                    if desc.contains("busy") || desc.contains("in use") || desc.contains("Access is denied") {
                        format!(
                            "Serial port '{}' is already in use by another application",
                            config.port
                        )
                    } else if desc.contains("not found") || desc.contains("cannot find") || desc.contains("No such file") {
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

/// All built-in Linux `/dev` prefixes scanned to supplement `serialport::available_ports()`.
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
/// Returns an empty vector if enumeration fails (e.g. on platforms where no
/// serial driver is loaded). On Linux, the result is supplemented with a
/// direct `/dev` scan using [`DEFAULT_EXTRA_LINUX_PREFIXES`] for device
/// patterns that the `serialport` crate may not enumerate.
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
#[cfg(target_os = "linux")]
pub(crate) fn list_serial_ports_with_dev(dev_dir: &std::path::Path) -> Vec<String> {
    list_serial_ports_with_dev_and_prefixes(dev_dir, DEFAULT_EXTRA_LINUX_PREFIXES)
}

fn list_serial_ports_with_dev_and_prefixes(
    dev_dir: &std::path::Path,
    extra_prefixes: &[&str],
) -> Vec<String> {
    let crate_ports: Vec<String> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
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

/// Scan `dev_dir` for Linux UART devices not always enumerated by the
/// `serialport` crate (e.g. PL011 UARTs on Raspberry Pi).
///
/// Matches `/dev` entries whose names start with any of the given `prefixes`.
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

/// Status of a serial port connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SerialStatus {
    Connected,
    Disconnected,
    Reconnecting,
    Error(String),
}

/// Reconnect interval used by [`serial_reader_loop`].
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// Background serial port reader loop with automatic reconnection.
///
/// Opens the port via [`open_serial_port`], reads data into a ring
/// buffer, and calls `output_fn` for every chunk received. On read
/// errors (other than timeout), enters a reconnect loop that retries
/// every 3 seconds until the port reappears or `closed` is set.
///
/// # Arguments
///
/// * `config` — Pre-parsed serial config (used for initial open and reconnects).
/// * `ring_buffer` — Shared ring buffer for 24/7 data capture.
/// * `alive` — Set to `true` while the port is connected, `false`
///   during disconnect/reconnect.
/// * `closed` — Set to `true` by the caller to request shutdown.
/// * `output_fn` — Called with each chunk of received bytes. Consumers
///   decide whether to forward (e.g., only when attached).
/// * `status_fn` — Called on connection state changes.
pub fn serial_reader_loop(
    config: &ParsedSerialConfig,
    ring_buffer: Arc<Mutex<RingBuffer>>,
    alive: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    output_fn: impl Fn(&[u8]) + Send,
    status_fn: impl Fn(SerialStatus) + Send,
) {
    // --- Initial open ---------------------------------------------------
    let port = match open_serial_port(config) {
        Ok(p) => p,
        Err(e) => {
            status_fn(SerialStatus::Error(e.to_string()));
            alive.store(false, Ordering::SeqCst);
            // Fall directly into the reconnect loop
            reconnect_loop_inner(
                config,
                &ring_buffer,
                &alive,
                &closed,
                &output_fn,
                &status_fn,
            );
            return;
        }
    };

    let mut reader = match port.try_clone() {
        Ok(r) => r,
        Err(e) => {
            status_fn(SerialStatus::Error(format!(
                "Failed to clone serial port: {}",
                e
            )));
            alive.store(false, Ordering::SeqCst);
            return;
        }
    };

    alive.store(true, Ordering::SeqCst);
    status_fn(SerialStatus::Connected);

    read_loop(
        config,
        &mut reader,
        &ring_buffer,
        &alive,
        &closed,
        &output_fn,
        &status_fn,
    );

    alive.store(false, Ordering::SeqCst);
}

/// Core read loop — extracted so it can be re-entered after reconnection.
fn read_loop(
    config: &ParsedSerialConfig,
    reader: &mut Box<dyn serialport::SerialPort>,
    ring_buffer: &Arc<Mutex<RingBuffer>>,
    alive: &Arc<AtomicBool>,
    closed: &Arc<AtomicBool>,
    output_fn: &(impl Fn(&[u8]) + Send),
    status_fn: &(impl Fn(SerialStatus) + Send),
) {
    let mut buf = [0u8; 1024];

    loop {
        if closed.load(Ordering::SeqCst) {
            return;
        }

        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — port closed
                return;
            }
            Ok(n) => {
                let data = &buf[..n];

                // Always store in ring buffer
                {
                    let mut rb = ring_buffer.lock().unwrap();
                    rb.write(data);
                }

                output_fn(data);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) => {
                alive.store(false, Ordering::SeqCst);
                status_fn(SerialStatus::Disconnected);
                status_fn(SerialStatus::Error(e.to_string()));

                // Attempt reconnection
                reconnect_loop_inner(config, ring_buffer, alive, closed, output_fn, status_fn);
                return;
            }
        }
    }
}

/// Retry opening the serial port every [`RECONNECT_INTERVAL`] until
/// success or `closed` is set. On success, enters the read loop.
fn reconnect_loop_inner(
    config: &ParsedSerialConfig,
    ring_buffer: &Arc<Mutex<RingBuffer>>,
    alive: &Arc<AtomicBool>,
    closed: &Arc<AtomicBool>,
    output_fn: &(impl Fn(&[u8]) + Send),
    status_fn: &(impl Fn(SerialStatus) + Send),
) {
    loop {
        if closed.load(Ordering::SeqCst) {
            return;
        }

        std::thread::sleep(RECONNECT_INTERVAL);

        if closed.load(Ordering::SeqCst) {
            return;
        }

        status_fn(SerialStatus::Reconnecting);

        match open_serial_port(config) {
            Ok(new_port) => match new_port.try_clone() {
                Ok(mut new_reader) => {
                    alive.store(true, Ordering::SeqCst);
                    status_fn(SerialStatus::Connected);

                    read_loop(
                        config,
                        &mut new_reader,
                        ring_buffer,
                        alive,
                        closed,
                        output_fn,
                        status_fn,
                    );
                    return;
                }
                Err(_) => continue,
            },
            Err(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_serial_config tests ---------------------------------------

    fn make_config(port: &str) -> SerialConfig {
        SerialConfig {
            port: port.to_string(),
            ..SerialConfig::default()
        }
    }

    #[test]
    fn parse_defaults() {
        let cfg = make_config("/dev/ttyUSB0");
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.port, "/dev/ttyUSB0");
        assert_eq!(parsed.baud_rate, 115200);
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
        assert_eq!(parsed.parity, serialport::Parity::None);
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_data_bits_five() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 5,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Five);
    }

    #[test]
    fn parse_data_bits_six() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 6,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Six);
    }

    #[test]
    fn parse_data_bits_seven() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 7,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Seven);
    }

    #[test]
    fn parse_data_bits_eight() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 8,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
    }

    #[test]
    fn parse_data_bits_unknown_defaults_to_eight() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            data_bits: 99,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.data_bits, serialport::DataBits::Eight);
    }

    #[test]
    fn parse_stop_bits_one() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 1,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
    }

    #[test]
    fn parse_stop_bits_two() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 2,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::Two);
    }

    #[test]
    fn parse_stop_bits_unknown_defaults_to_one() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            stop_bits: 42,
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.stop_bits, serialport::StopBits::One);
    }

    #[test]
    fn parse_parity_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::None);
    }

    #[test]
    fn parse_parity_odd() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "odd".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::Odd);
    }

    #[test]
    fn parse_parity_even() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "even".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::Even);
    }

    #[test]
    fn parse_parity_unknown_defaults_to_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            parity: "mark".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.parity, serialport::Parity::None);
    }

    #[test]
    fn parse_flow_control_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "none".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_flow_control_hardware() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "hardware".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::Hardware);
    }

    #[test]
    fn parse_flow_control_software() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "software".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::Software);
    }

    #[test]
    fn parse_flow_control_unknown_defaults_to_none() {
        let cfg = SerialConfig {
            port: "COM1".into(),
            flow_control: "xonxoff".into(),
            ..SerialConfig::default()
        };
        let parsed = parse_serial_config(&cfg).unwrap();
        assert_eq!(parsed.flow_control, serialport::FlowControl::None);
    }

    #[test]
    fn parse_empty_port_returns_error() {
        let cfg = SerialConfig::default(); // port is empty
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
        assert_eq!(parsed.data_bits, serialport::DataBits::Seven);
        assert_eq!(parsed.stop_bits, serialport::StopBits::Two);
        assert_eq!(parsed.parity, serialport::Parity::Even);
        assert_eq!(parsed.flow_control, serialport::FlowControl::Hardware);
    }

    // --- list_serial_ports tests -----------------------------------------

    #[test]
    fn list_serial_ports_returns_vec() {
        // Hardware-dependent — just verify it returns without panicking.
        let ports = list_serial_ports();
        // ports may be empty on CI; that's fine.
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
            data_bits: serialport::DataBits::Eight,
            stop_bits: serialport::StopBits::One,
            parity: serialport::Parity::None,
            flow_control: serialport::FlowControl::None,
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

    // --- SerialStatus tests ----------------------------------------------

    #[test]
    fn serial_status_equality() {
        assert_eq!(SerialStatus::Connected, SerialStatus::Connected);
        assert_eq!(SerialStatus::Disconnected, SerialStatus::Disconnected);
        assert_eq!(SerialStatus::Reconnecting, SerialStatus::Reconnecting);
        assert_eq!(
            SerialStatus::Error("oops".into()),
            SerialStatus::Error("oops".into())
        );
        assert_ne!(SerialStatus::Connected, SerialStatus::Disconnected);
        assert_ne!(
            SerialStatus::Error("a".into()),
            SerialStatus::Error("b".into())
        );
    }

    #[test]
    fn serial_status_clone() {
        let s = SerialStatus::Error("test".into());
        let cloned = s.clone();
        assert_eq!(s, cloned);
    }

    #[test]
    fn serial_status_debug() {
        let s = SerialStatus::Connected;
        let debug = format!("{:?}", s);
        assert!(debug.contains("Connected"));
    }
}
