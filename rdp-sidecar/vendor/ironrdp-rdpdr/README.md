# IronRDP RDPDR (termiHub vendored fork)

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpdr` **0.9.0** for termiHub's RDP sidecar. It was first
forked from 0.7.0 for [`termiHub#4125`](https://github.com/armaxri/termiHub/issues/4125) and
re-based onto 0.9.0 for [`termiHub#5117`](https://github.com/armaxri/termiHub/issues/5117). It is
patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`, like
`rdp-sidecar/vendor/ironrdp-pdu`.

**Fork base:** upstream tag `ironrdp-rdpdr-v0.9.0`, commit
[`b13befa0db86f48f523a0b2b007e399f9811e0ec`](https://github.com/Devolutions/IronRDP/commit/b13befa0db86f48f523a0b2b007e399f9811e0ec)
of [IronRDP](https://github.com/Devolutions/IronRDP), copied from the crates.io package
(without its registry-only `.cargo_vcs_info.json`, `Cargo.lock` and `Cargo.toml.orig`). The
fork is registered in [`vendor/vendored-forks.json`](../../../vendor/vendored-forks.json), and
a weekly CI job reports upstream releases, commits and advisories that the fork does not have
yet. See `docs/supply-chain.md` → "Vendored forks". Update both when re-basing or reviewing
upstream again. The status, prepared upstream text and retirement steps are in
[`UPSTREAM.md`](UPSTREAM.md).

### Change 1: drive DeviceData as sanitised 8-bit characters ([#4923])

A port of upstream
[`4cd9d4506`](https://github.com/Devolutions/IronRDP/commit/4cd9d45060df01c731f5d814537ecd86d425190d)
("fix(rdpdr): announce drive names as 8-bit characters", IronRDP#2342), which fixed
IronRDP#2075 on master after the 0.9.0 release (unreleased). 0.9.0 announces a drive's full
name in `DeviceData` as UTF-16LE, as MS-RDPEFS 2.2.3.1 asks, but Windows reads the field as
8-bit characters, so a Windows host shows the drive under its first letter only (IronRDP#2075).
`DeviceAnnounceHeader::new_drive` (`src/pdu/efs.rs`) now writes the name null-terminated as
8-bit characters, with the characters MS-RDPEFS 2.2.1.3 forbids, a colon before the end, a NUL
and every non-ASCII character replaced by `_`; a trailing colon stays. `PreferredDosName`
(0.9.0's `PreferredDosName::for_drive`, the upstream form of this fork's former change 1,
[#4125]) is unchanged, so xrdp keeps mounting the drive under its name. The
`crates/ironrdp-rdpdr` part of the commit is applied as is. Tests: `termihub_fork_tests` at the
end of `src/pdu/efs.rs`, the sidecar's
`rdp::tests::drive_announce_carries_the_drive_name_in_preferred_dos_name` and the live xrdp test
RDP-15 (`core/tests/rdp.rs`).

### Change 2: Device I/O Requests with an unknown MajorFunction are completed ([#5124])

**Fork-only; upstream master still fails such a request.** In 0.9.0 a Device I/O Request whose
MajorFunction is not one the crate knows fails to decode before the device is even looked up,
and `ironrdp-session` ends the whole RDP session. MS-RDPEFS 3.1.5.2 says such a request SHOULD
be completed with `STATUS_UNSUCCESSFUL`:

- `Rdpdr::process` decodes the header of a `PAKID_CORE_DEVICE_IOREQUEST` through the
  crate-private `DeviceIoRequest::decode_or_unknown`, which returns a well-formed header with an
  unknown MajorFunction as an `UnknownMajorFunctionRequest` instead of an error.
- `Rdpdr::handle_unknown_major_function` completes it with a header-only `STATUS_UNSUCCESSFUL`
  `DR_DEVICE_IOCOMPLETION` when the device was announced and not rejected, and ignores it
  otherwise, as 0.9.0 ignores any other IRP for such a device.

A header cut short is still a decode error, and the public `DeviceIoRequest::decode` still
rejects an unknown MajorFunction. Marked `termiHub fork delta (#5124)`; tests
`termihub_unknown_major_function_*`, `termihub_a_device_io_request_header_cut_short_*` and
`termihub_public_decode_still_rejects_an_unknown_major_function` in `src/lib.rs`, and the
sidecar's `rdp::tests::unknown_major_function_irp_is_completed_and_the_channel_keeps_serving`.
The crate's tests run with `cargo test -p ironrdp-rdpdr` from `rdp-sidecar/`.

### Re-base onto 0.9.0 ([#5117])

0.9.0 has the rest of what the 0.7.0 fork carried, so the re-base dropped it:
`PreferredDosName::for_drive` (`161409e18dd1`, [#4125]), the completion of unsupported drive
IRPs with `STATUS_NOT_SUPPORTED` / `STATUS_UNSUCCESSFUL` (`0f9154d2`, [#5118]) and the flush and
security MajorFunctions (`d1c63ecd7b`, [#5124]). 0.9.0 hands Query Security and Set Security
requests to the backend; the sidecar's `DriveRedirectBackend` (`rdp-sidecar/src/drive.rs`)
completes them with `STATUS_NOT_SUPPORTED` in the same response layouts the fork used, and
leaves `RdpdrBackend::supports_drive_security` `false`.

0.9.0 also changes when the channel serves a drive: it ignores an IRP for a device it has not
announced yet, or that the server rejected (MS-RDPEFS 3.1.5.2), where 0.7.0 served every listed
device, and it announces drives after the User Logged On PDU. The sidecar's drive tests run the
initialization sequence first (`rdp::tests::announced_drive_rdpdr`).

### Upstream review

Reviewed upstream `crates/ironrdp-rdpdr` up to IronRDP
[`d5e70f02`](https://github.com/Devolutions/IronRDP/commit/d5e70f02b670dbe79ad7ef47203bfa82d32c16f4)
(2026-11-09): `4cd9d4506` (change 1) is the only commit after 0.9.0.

Retire the fork once an `ironrdp-rdpdr` release contains `4cd9d4506` **and** completes an
unknown MajorFunction instead of failing to decode it (or carry change 2 alone until then).
Apart from changes 1 and 2, everything is byte-for-byte upstream 0.9.0.

[#4125]: https://github.com/armaxri/termiHub/issues/4125
[#4923]: https://github.com/armaxri/termiHub/issues/4923
[#5117]: https://github.com/armaxri/termiHub/issues/5117
[#5118]: https://github.com/armaxri/termiHub/issues/5118
[#5124]: https://github.com/armaxri/termiHub/issues/5124

---


Implements the RDPDR static virtual channel as described in
[\[MS-RDPEFS\]: Remote Desktop Protocol: File System Virtual Channel Extension][spec]

[spec]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/34d9de58-b2b5-40b6-b970-f82d4603bdb5

This crate is part of the [IronRDP] project.

## Virtual Printers

`Rdpdr::with_printer` announces a PostScript virtual printer using
`MS Publisher Imagesetter` as the default server-side driver. This matches
FreeRDP's default CUPS printer driver for PostScript redirection and keeps the
client format-agnostic: printer IRPs deliver the raw job bytes to the backend.
Printer devices are advertised after the server sends `RDPDR_USER_LOGGEDON_PDU`;
pre-logon announces remain reserved for special devices such as smart cards.

Use `Rdpdr::with_printer_driver` when the target host needs a different
installed printer driver. The selected driver controls the document format the
server writes to the redirected printer, so consumers are responsible for any
PostScript-to-PDF or other conversion step before presenting the job to a user.

`Rdpdr::with_redirected_printer` announces an `RdpdrPrinter` with its own flags and cached configuration.
Call it once per printer: each one gets its own `PRN<n>` port name, and only the first printer marked default keeps the default flag, as MS-RDPEPC 2.2.2.1 requires.

## Printer Cache Data

Windows servers send `PAKID_PRN_CACHE_DATA` when a user changes printing preferences, installs a queue on the redirected port, or renames or deletes a redirected queue (MS-RDPEPC 3.2.5.1.3 to 3.2.5.1.6).
`Rdpdr::with_printer_cache_store` saves these through an embedder-supplied `RdpdrPrinterCacheStore` and sends the saved data back as `CachedPrinterConfigData` in the next announcement.
A driver saved from an add event replaces the announced driver unless the printer was created with `with_explicit_driver(true)`.
Cached configuration is driver-specific (MS-RDPEPC 3.1.1.1), so each entry records the driver it was produced for, and it is not sent with another driver.
The channel does no I/O itself: `InMemoryRdpdrPrinterCacheStore` keeps entries for the process lifetime, and `ironrdp-rdpdr-native` provides a file-backed store.
Store errors, oversized blobs (over 256 KiB), and messages for printers this client did not announce are logged and ignored; a malformed message fails the channel, as other malformed RDPDR packets do (MS-RDPEFS 3.1.5.2).
Entries are keyed by the local queue name and record the name the server gave the printer, from a rename event or a queue installed on the redirected port, so the next announcement uses that name (MS-RDPEPC 3.2.5.1.3, 3.2.5.1.6).
The redirected printer is renamed, not the local Windows queue: a server must not rename printers on the client machine.

`PAKID_PRN_USING_XPS` is decoded and ignored, because this crate never sets `RDPDR_PRINTER_ANNOUNCE_FLAG_XPSFORMAT`.

[IronRDP]: https://github.com/Devolutions/IronRDP
