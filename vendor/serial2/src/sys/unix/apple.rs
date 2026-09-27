use std::path::PathBuf;
use std::os::unix::io::RawFd;

/// A ioctl to set the baud rate of a serial port.
///
/// Value taken from random forum because there is no public documentation.
/// * https://fpc-pascal.freepascal.narkive.com/oI4b0CM2/non-standard-baud-rates-in-os-x-iossiospeed-ioctl
/// * https://github.com/dcuddeback/serial-rs/issues/37
const IOCTL_IOSSIOSPEED: u64 = 0x80045402;

/// Set the baud rate of a serial port using the IOSSIOSPEED ioctl.
///
/// The speed set this way applied to the input and the output speed.
///
/// According to some source, the speed set this way is *not* reported back in the `termios` struct by `tcgetattr`,
/// but according to other sources it *is*.
/// Even the two examples from Apple below contradict each-other on this point.
///
/// Testing seems to suggest that the value *is* reported correctly by `tcgetattr`.
/// So to avoid synchronization problems with other FDs for the same serial port we trust `tcgetattr`.
/// https://github.com/de-vri-es/serial2-rs/issues/38#issuecomment-2182531900
///
/// This is Apple, so there is no public documentation (why would you?).
/// This is the best I could find:
/// * https://opensource.apple.com/source/IOSerialFamily/IOSerialFamily-91/tests/IOSerialTestLib.c.auto.html
/// * https://developer.apple.com/library/archive/samplecode/SerialPortSample/Listings/SerialPortSample_SerialPortSample_c.html
pub fn ioctl_iossiospeed(fd: RawFd, baud_rate: libc::speed_t) -> Result<(), std::io::Error> {
	unsafe {
		super::check(libc::ioctl(fd, IOCTL_IOSSIOSPEED, &baud_rate))?;
		Ok(())
	}
}

/// The baud rates that plain termios (`cfsetspeed` / `tcsetattr`) can express on Apple platforms.
///
/// termiHub fork delta (armaxri/termiHub#3701).
const STANDARD_TERMIOS_SPEEDS: &[libc::speed_t] = &[
	libc::B50,
	libc::B75,
	libc::B110,
	libc::B134,
	libc::B150,
	libc::B200,
	libc::B300,
	libc::B600,
	libc::B1200,
	libc::B1800,
	libc::B2400,
	libc::B4800,
	libc::B7200,
	libc::B9600,
	libc::B14400,
	libc::B19200,
	libc::B28800,
	libc::B38400,
	libc::B57600,
	libc::B76800,
	libc::B115200,
	libc::B230400,
];

/// Decide whether a failed `IOSSIOSPEED` ioctl may fall back to setting the speed through termios.
///
/// termiHub fork delta (armaxri/termiHub#3701). Pseudo-terminals (for example a `socat` pty pair)
/// and serial drivers without custom-speed support reject the ioctl with `ENOTTY`
/// ("Inappropriate ioctl for device") or `ENOTSUP`/`EOPNOTSUPP`, even though `tcsetattr` works on them.
///
/// The fallback is only taken when the requested input and output speeds are equal and a standard
/// termios rate, so a non-standard rate is never silently dropped on a device that cannot apply it:
/// the original error is returned instead. Every other error is returned unchanged as well.
pub fn can_fall_back_to_termios_speed(error: &std::io::Error, input_speed: libc::speed_t, output_speed: libc::speed_t) -> bool {
	let unsupported_ioctl = matches!(
		error.raw_os_error(),
		Some(libc::ENOTTY) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
	);
	unsupported_ioctl && input_speed == output_speed && STANDARD_TERMIOS_SPEEDS.contains(&output_speed)
}

pub fn enumerate() -> std::io::Result<Vec<PathBuf>> {
	use std::os::unix::ffi::OsStrExt;
	use std::os::unix::fs::FileTypeExt;

	let serial_ports = std::fs::read_dir("/dev")?
		.filter_map(|entry| {
			let entry = entry.ok()?;
			let kind = entry.metadata().ok()?.file_type();
			if kind.is_char_device() && is_tty_name(entry.file_name().as_bytes()) {
				Some(entry.path())
			} else {
				None
			}
		})
		.collect();
	Ok(serial_ports)
}

fn is_tty_name(name: &[u8]) -> bool {
	// Sigh, closed source doesn't have to mean undocumented.
	// Anyway:
	// https://stackoverflow.com/questions/14074413/serial-port-names-on-mac-os-x
	// https://learn.adafruit.com/ftdi-friend/com-slash-serial-port-name
	name.starts_with(b"tty.") || name.starts_with(b"cu.")
}

#[cfg(test)]
mod tests {
	use super::can_fall_back_to_termios_speed;

	fn os_error(code: i32) -> std::io::Error {
		std::io::Error::from_raw_os_error(code)
	}

	#[test]
	fn falls_back_for_unsupported_ioctl_at_standard_rates() {
		for code in [libc::ENOTTY, libc::ENOTSUP, libc::EOPNOTSUPP] {
			assert!(can_fall_back_to_termios_speed(&os_error(code), 9600, 9600));
			assert!(can_fall_back_to_termios_speed(&os_error(code), 115200, 115200));
			assert!(can_fall_back_to_termios_speed(&os_error(code), 230400, 230400));
		}
	}

	#[test]
	fn keeps_error_for_non_standard_rates() {
		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 250000, 250000));
		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 1_000_000, 1_000_000));
		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 0, 0));
	}

	#[test]
	fn keeps_error_for_split_speeds() {
		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 9600, 115200));
	}

	#[test]
	fn keeps_other_errors() {
		for code in [libc::EINVAL, libc::EIO, libc::EBADF, libc::ENXIO] {
			assert!(!can_fall_back_to_termios_speed(&os_error(code), 9600, 9600));
		}
		let no_os_code = std::io::Error::new(std::io::ErrorKind::Other, "boom");
		assert!(!can_fall_back_to_termios_speed(&no_os_code, 9600, 9600));
	}
}
