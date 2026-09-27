# Upstreaming the macOS pseudo-terminal baud fallback

Prepared submission of this fork's only code delta to
[de-vri-es/serial2-rs](https://github.com/de-vri-es/serial2-rs), so the fork can be
retired (#3704). Nothing has been submitted yet: a maintainer opens the upstream issue
and pull request (see [How to submit](#how-to-submit)).

- **Base:** upstream `v0.2.38`, commit `448a20ece5e6e37236d247ed957042420672029b` (also the
  tip of upstream `main` when this was prepared, 2026-09-27).
- **Upstream search:** no open or closed issue/PR covers `IOSSIOSPEED` failing on
  pseudo-terminals (the related history is upstream #39, which introduced the ioctl).
- **Verified:** the patch below applies cleanly to `v0.2.38` (`git apply --check`), and
  `cargo test --features unix` passes on macOS with it. Without it, upstream's own
  `tests/pair.rs` (`open_pair`) fails on macOS.

## Suggested pull request

**Title:** `Fall back to termios speed on Apple when IOSSIOSPEED is not supported`

**Description:**

> On macOS and iOS, `SerialPort::set_configuration()` always sets the baud rate with the
> `IOSSIOSPEED` ioctl. Pseudo-terminals (a `socat` pty pair, serial-port emulators,
> `SerialPort::pair()`) and drivers without custom-speed support reject that ioctl with
> `ENOTTY` ("Inappropriate ioctl for device"), so such a port cannot be opened or
> configured at all, even at a standard rate like 9600 that `tcsetattr` handles fine.
> This is also why `tests/pair.rs` fails on macOS today.
>
> This change keeps `IOSSIOSPEED` as the primary path, so devices that accept it behave
> exactly as before. Only when the ioctl fails with `ENOTTY`, `ENOTSUP` or `EOPNOTSUPP`,
> the input and output speeds are equal, and the speed is a standard termios rate
> (`B50` to `B230400`), the settings are applied again with `tcsetattr` using the real
> speed. For a non-standard rate, split speeds or any other error, the original ioctl
> error is returned, so a requested rate is never silently dropped. The existing
> `matches_requested()` check still verifies the result.
>
> Unit tests cover the fallback decision; `tests/pair.rs` now passes on macOS.

## Rationale for the design

- **Narrow trigger.** Only "this device does not support the ioctl" errors fall back.
  Permission, I/O and bad-descriptor errors still surface unchanged.
- **No silent rate change.** Termios on Apple platforms can only express the `Bxxx`
  constants, which on Apple equal the numeric rate. A custom rate on a device that
  rejects `IOSSIOSPEED` cannot be applied, so it stays an error instead of falling back
  to whatever speed termios happens to keep.
- **Equal speeds only.** `IOSSIOSPEED` sets both directions at once; the fallback keeps
  that contract.
- **No behaviour change for real hardware.** USB-serial adapters that accept the ioctl
  never reach the new code.

## The patch

Against `v0.2.38`. It is the fork's delta without the termiHub-specific
`termiHub fork delta (armaxri/termiHub#3701)` comment markers. The vendored copy's
other differences from upstream are packaging only and are **not** part of the
submission: `README.md` (fork notes; upstream's is kept as `README.upstream.md`), this
file, and `/Cargo.lock` in `.gitignore`; the upstream `.github/`, `README.tpl` and
`check-targets` are not vendored. The diff keeps upstream's tab indentation, so it applies
as-is.

<!-- markdownlint-disable MD010 -->

```diff
diff --git a/src/sys/unix/apple.rs b/src/sys/unix/apple.rs
index 2faaf68..ed314d4 100644
--- a/src/sys/unix/apple.rs
+++ b/src/sys/unix/apple.rs
@@ -31,6 +31,49 @@ pub fn ioctl_iossiospeed(fd: RawFd, baud_rate: libc::speed_t) -> Result<(), std:
 	}
 }

+/// The baud rates that plain termios (`cfsetspeed` / `tcsetattr`) can express on Apple platforms.
+const STANDARD_TERMIOS_SPEEDS: &[libc::speed_t] = &[
+	libc::B50,
+	libc::B75,
+	libc::B110,
+	libc::B134,
+	libc::B150,
+	libc::B200,
+	libc::B300,
+	libc::B600,
+	libc::B1200,
+	libc::B1800,
+	libc::B2400,
+	libc::B4800,
+	libc::B7200,
+	libc::B9600,
+	libc::B14400,
+	libc::B19200,
+	libc::B28800,
+	libc::B38400,
+	libc::B57600,
+	libc::B76800,
+	libc::B115200,
+	libc::B230400,
+];
+
+/// Decide whether a failed `IOSSIOSPEED` ioctl may fall back to setting the speed through termios.
+///
+/// Pseudo-terminals (for example a `socat` pty pair)
+/// and serial drivers without custom-speed support reject the ioctl with `ENOTTY`
+/// ("Inappropriate ioctl for device") or `ENOTSUP`/`EOPNOTSUPP`, even though `tcsetattr` works on them.
+///
+/// The fallback is only taken when the requested input and output speeds are equal and a standard
+/// termios rate, so a non-standard rate is never silently dropped on a device that cannot apply it:
+/// the original error is returned instead. Every other error is returned unchanged as well.
+pub fn can_fall_back_to_termios_speed(error: &std::io::Error, input_speed: libc::speed_t, output_speed: libc::speed_t) -> bool {
+	let unsupported_ioctl = matches!(
+		error.raw_os_error(),
+		Some(libc::ENOTTY) | Some(libc::ENOTSUP) | Some(libc::EOPNOTSUPP)
+	);
+	unsupported_ioctl && input_speed == output_speed && STANDARD_TERMIOS_SPEEDS.contains(&output_speed)
+}
+
 pub fn enumerate() -> std::io::Result<Vec<PathBuf>> {
 	use std::os::unix::ffi::OsStrExt;
 	use std::os::unix::fs::FileTypeExt;
@@ -56,3 +99,42 @@ fn is_tty_name(name: &[u8]) -> bool {
 	// https://learn.adafruit.com/ftdi-friend/com-slash-serial-port-name
 	name.starts_with(b"tty.") || name.starts_with(b"cu.")
 }
+
+#[cfg(test)]
+mod tests {
+	use super::can_fall_back_to_termios_speed;
+
+	fn os_error(code: i32) -> std::io::Error {
+		std::io::Error::from_raw_os_error(code)
+	}
+
+	#[test]
+	fn falls_back_for_unsupported_ioctl_at_standard_rates() {
+		for code in [libc::ENOTTY, libc::ENOTSUP, libc::EOPNOTSUPP] {
+			assert!(can_fall_back_to_termios_speed(&os_error(code), 9600, 9600));
+			assert!(can_fall_back_to_termios_speed(&os_error(code), 115200, 115200));
+			assert!(can_fall_back_to_termios_speed(&os_error(code), 230400, 230400));
+		}
+	}
+
+	#[test]
+	fn keeps_error_for_non_standard_rates() {
+		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 250000, 250000));
+		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 1_000_000, 1_000_000));
+		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 0, 0));
+	}
+
+	#[test]
+	fn keeps_error_for_split_speeds() {
+		assert!(!can_fall_back_to_termios_speed(&os_error(libc::ENOTTY), 9600, 115200));
+	}
+
+	#[test]
+	fn keeps_other_errors() {
+		for code in [libc::EINVAL, libc::EIO, libc::EBADF, libc::ENXIO] {
+			assert!(!can_fall_back_to_termios_speed(&os_error(code), 9600, 9600));
+		}
+		let no_os_code = std::io::Error::new(std::io::ErrorKind::Other, "boom");
+		assert!(!can_fall_back_to_termios_speed(&no_os_code, 9600, 9600));
+	}
+}
diff --git a/src/sys/unix/mod.rs b/src/sys/unix/mod.rs
index 22f73bf..7fb0a9c 100644
--- a/src/sys/unix/mod.rs
+++ b/src/sys/unix/mod.rs
@@ -199,8 +199,18 @@ impl SerialPort {
 		apply_settings.set_on_file(&mut self.file)?;

 		// On iOS and macOS, override the speed with the IOSSIOSPEED ioctl.
+		//
+		// Pseudo-terminals (socat pairs, serial emulators) and drivers without custom-speed
+		// support reject the ioctl with ENOTTY/ENOTSUP.
+		// For a standard rate that termios can express, apply the speed with `tcsetattr` instead;
+		// any other failure (or a non-standard rate) is still returned unchanged.
 		#[cfg(any(target_os = "ios", target_os = "macos"))]
-		ioctl_iossiospeed(self.file.as_raw_fd(), settings.termios.c_ospeed)?;
+		if let Err(error) = ioctl_iossiospeed(self.file.as_raw_fd(), settings.termios.c_ospeed) {
+			if !can_fall_back_to_termios_speed(&error, settings.termios.c_ispeed, settings.termios.c_ospeed) {
+				return Err(error);
+			}
+			settings.set_on_file(&mut self.file)?;
+		}

 		let applied_settings = self.get_configuration()?;
 		if !applied_settings.matches_requested(settings) {
```

<!-- markdownlint-enable MD010 -->

## How to submit

1. Fork `de-vri-es/serial2-rs` and branch from `main` (check that `main` still has no
   equivalent fix; if upstream moved, re-apply by hand, since the delta is two small hunks).
2. Save the diff above as `iossiospeed-fallback.patch` and apply it with
   `git apply iossiospeed-fallback.patch`.
3. Run `cargo test --features unix` on macOS; `tests/pair.rs` and the new
   `sys::unix::apple::tests` must pass. Format with the repository's `rustfmt.toml`
   (`cargo +nightly fmt`), since it uses unstable options.
4. Open the pull request with the title and description above, and add a line to
   upstream's `CHANGELOG` if the maintainer asks for it.
5. Record the pull request link in `vendor/vendored-forks.json` (the delta's `refs`) and
   in `docs/supply-chain.md` → "Upstreaming status".

## Retiring the fork

Once a `serial2` release contains the fix:

1. Remove the `[patch.crates-io]` entry for `serial2` from the root `Cargo.toml`, bump
   the workspace `serial2` requirement to that release, and run `cargo update -p serial2`.
2. Delete `vendor/serial2/`, its entry in `vendor/vendored-forks.json`, its row in the
   "Vendored forks" table of `docs/supply-chain.md`, and update the parser watchlist row.
3. Keep the `core/src/backends/serial.rs` `macos_pty` tests: they then guard the upstream
   fix.
