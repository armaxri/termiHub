# IronRDP RDPDR (termiHub vendored fork)

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpdr` **0.7.0** for termiHub's RDP sidecar
(see [`termiHub#4125`](https://github.com/armaxri/termiHub/issues/4125)). It is
patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`,
exactly like `rdp-sidecar/vendor/ironrdp-pdu`. The sidecar depends on
`ironrdp-rdpdr` directly (#5117), so the patch redirects that dependency.

**Fork base:** upstream tag `ironrdp-rdpdr-v0.7.0`, commit
[`11a0810cfbbabd8b8023875a05e3041216d4b01b`](https://github.com/Devolutions/IronRDP/commit/11a0810cfbbabd8b8023875a05e3041216d4b01b)
of [IronRDP](https://github.com/Devolutions/IronRDP), copied from the crates.io
package. The fork is registered in
[`vendor/vendored-forks.json`](../../../vendor/vendored-forks.json), and a weekly CI
job reports upstream releases, commits and advisories that the fork does not have
yet — see `docs/supply-chain.md` → "Vendored forks". Update both when re-basing or
reviewing upstream again.

### Change 1: name redirected drives in PreferredDosName ([#4125])

A Device Announce Header (MS-RDPEFS 2.2.1.3) has an 8-byte ASCII
`PreferredDosName` field (at most 7 characters plus a null terminator) and a
variable `DeviceData` field. Upstream 0.7.0's `DeviceAnnounceHeader::new_drive`
always writes the literal `ignored` into `PreferredDosName` and the real name into
`DeviceData`. The spec says a server uses `DeviceData` when it is non-empty, but
xrdp's devredir reads only `PreferredDosName`, so every drive the sidecar
redirected showed up on an xrdp host as `~/thinclient_drives/ignored` (chansrv
logs `Detected remote drive 'ignored'`). FreeRDP fills both fields, which is why
its drives keep their names on xrdp.

The fork derives `PreferredDosName` from the drive name with
`PreferredDosName::for_drive` (`src/pdu/efs.rs`): it keeps the leading run of
valid characters (ASCII alphanumerics, space, `_`, `-`, `.`, and `:` only as the
last character), at most 7 of them, and falls back to `DRIVE` when nothing valid
is left. Any other character, including every non-ASCII one, ends the name. So
`termiHub` is sent as `termiHu`, `share` as `share`, `Données` as `Donn`.
`DeviceData` carries the full name as null-terminated 8-bit characters (change 2).

`for_drive` is a straight port of the function upstream added in
[`161409e18dd1`](https://github.com/Devolutions/IronRDP/commit/161409e18dd185de9bb30730303e56f5e8d28941)
("feat(rdpdr): add filesystem PDU foundation", IronRDP#1566), which landed on
master after 0.7.0 and is not yet released. That upstream commit also switched
`DeviceData` to UTF-16LE; the fork does **not** take that part, because Windows
hosts then expose the drive under its first letter only (IronRDP#2075). The
code changes are marked `termiHub fork delta (#4125)`, and `src/pdu/efs.rs` ends
with the fork's unit tests (`termihub_fork_tests`). `[lib] test = false` was
removed from `Cargo.toml` so they run: `cargo test -p ironrdp-rdpdr` from
`rdp-sidecar/`. The sidecar's own
`rdp::tests::drive_announce_carries_the_drive_name_in_preferred_dos_name` and the
live xrdp test RDP-15 (`core/tests/rdp.rs`) cover the fix from outside.
Apart from changes 1 to 4, everything is byte-for-byte upstream 0.7.0, without the registry-only
`Cargo.lock`, `Cargo.toml.orig` and VCS metadata.

### Change 2: drive DeviceData as sanitised 8-bit characters ([#4923])

A port of upstream
[`4cd9d4506`](https://github.com/Devolutions/IronRDP/commit/4cd9d45060df01c731f5d814537ecd86d425190d)
("fix(rdpdr): announce drive names as 8-bit characters", IronRDP#2342), which fixed
IronRDP#2075 on master after the 0.9.0 release (unreleased). Windows reads the drive
`DeviceData` as 8-bit characters, and refuses a name containing a character MS-RDPEFS
2.2.1.3 forbids. 0.7.0 sent the raw UTF-8 bytes, so a drive label with `<`, `>`, `"`,
`/`, `\`, `|` or a colon before its end was refused, and a non-ASCII label arrived as
mojibake. `DeviceAnnounceHeader::new_drive` now writes each such character, a NUL and
every non-ASCII character as `_` (a trailing colon stays), exactly as upstream does;
`PreferredDosName` (change 1) is unchanged. Marked `termiHub fork delta (#4923)`; test
`device_data_replaces_forbidden_characters`.

### Change 3: complete unsupported drive IRPs instead of ending the session ([#5118])

A port of upstream
[`0f9154d2`](https://github.com/Devolutions/IronRDP/commit/0f9154d2128f8c65f4d51f6b7eb7cb1d66a12329)
("fix(rdpdr): complete unsupported drive IRPs instead of failing", IronRDP#2174), which is in
the 0.9.0 release. In 0.7.0 a well-formed drive I/O request that the crate does not implement
is a decode error, and `ironrdp-session` turns that into the end of the whole RDP session. This
hit `IRP_MJ_SET_VOLUME_INFORMATION` (for example a volume-label change in Windows Explorer on
the shared folder), Set Information / Query Volume Information / Query Directory requests with
an information class outside the accepted lists, and `IRP_MJ_DIRECTORY_CONTROL` with another
minor function.

`ServerDriveIoRequest::decode_or_unsupported` (`src/pdu/efs.rs`) returns such a request as an
`UnsupportedDriveIoRequest` after consuming its whole body, and
`Rdpdr::unsupported_drive_io_response` (`src/lib.rs`) completes it without asking the backend:
`STATUS_NOT_SUPPORTED`, echoing `Length` in the Set Volume Information and Set Information
responses as MS-RDPEFS 2.2.3.4.7 / 2.2.3.4.9 require, or `STATUS_UNSUCCESSFUL` in a
header-only completion for an undescribed minor function (MS-RDPEFS 3.1.5.2). A malformed
request (a buffer shorter than its declared length) is still a decode error, and the public
`ServerDriveIoRequest::decode` still rejects the unsupported ones.

Adapted rather than applied: 0.7.0 has no `ServerDriveSetVolumeInformationRequest` or
`ClientDriveSetVolumeInformationResponse`, so the fork reads the request frame with
`decode_set_volume_information_frame` and encodes the response as a crate-private
`pdu::DeviceIoCompletion` (as upstream does for the header-only reply). 0.7.0 has no
trailing-data check in the processor, so none was added; the `MajorFunction`s 0.7.0 does not
know (`FlushBuffers`, `QuerySecurity`, `SetSecurity`) are change 4. The private
`decode` of the Query Directory and Set Information requests became `decode_class`, and
`ClientDriveSetInformationResponse`'s fields are crate-visible, as upstream. Marked
`termiHub fork delta (#5118)`; tests in `src/lib.rs` (`termihub_fork_tests`) and the
sidecar's `rdp::tests::unsupported_drive_irp_is_completed_and_the_channel_keeps_serving`.

### Change 4: complete IRPs with an unknown MajorFunction instead of ending the session ([#5124])

The same class of bug one layer earlier. 0.7.0's `DeviceIoRequest::decode` fails on any
MajorFunction outside its list, before the device is even looked up, so `ironrdp-session` ended
the whole RDP session. Windows hosts send three such functions on a redirected drive:
`IRP_MJ_FLUSH_BUFFERS` (0x09, `FlushFileBuffers` on a file in the shared folder),
`IRP_MJ_QUERY_SECURITY` (0x14) and `IRP_MJ_SET_SECURITY` (0x15, reading or changing its ACL).
None of them is in the MS-RDPEFS 2.2.1.4 table.

- `MajorFunction` gains `FlushBuffers`, `QuerySecurity` and `SetSecurity`, and the crate gains
  `DeviceFlushBuffersRequest`, `DeviceFlushBuffersResponse`,
  `ServerDriveIoRequest::DeviceFlushBuffersRequest` and `RdpdrPdu::DeviceFlushBuffersResponse`,
  ported from upstream
  [`d1c63ecd7b`](https://github.com/Devolutions/IronRDP/commit/d1c63ecd7bd13c9ae3d88f3ae84176f214f41f61)
  ("feat(rdpdr): add advanced Windows filesystem semantics", IronRDP#1590, in the 0.9.0
  release) with the same names, so the upgrade is source-compatible.
- A drive flush goes to the backend like any supported request. The sidecar's
  `DriveRedirectBackend` answers it with an fsync of the file (`rdp-sidecar/src/drive.rs`).
- Query and set security are completed by `Rdpdr::unsupported_drive_io_response` with
  `STATUS_NOT_SUPPORTED`, in the response layouts master uses
  (`ClientDriveQuerySecurityResponse` with a zero Length and no descriptor,
  `ClientDriveSetSecurityResponse` echoing the request's Length), encoded as crate-private
  `DeviceIoCompletion` variants. The client has no Windows ACLs to report or apply. Their bodies
  are still checked for framing (`decode_query_security_frame` / `decode_set_security_frame`).
- Any other MajorFunction is completed with a header-only `STATUS_UNSUCCESSFUL`, as MS-RDPEFS
  3.1.5.2 says for an undescribed MajorFunction (`Rdpdr::handle_unknown_major_function`, fed by
  the crate-private `DeviceIoRequest::decode_or_unknown`), or ignored when its DeviceId was never
  announced. **This part is fork-only:** upstream master still fails to decode such a request.

A header cut short and a security request shorter than its frame are still decode errors. The
public `DeviceIoRequest::decode` still rejects an unknown MajorFunction, and the public
`ServerDriveIoRequest::decode` still rejects the security requests. Marked
`termiHub fork delta (#5124)`; tests in `src/lib.rs` (`termihub_fork_tests`), the sidecar's
`rdp::tests::unknown_major_function_irp_is_completed_and_the_channel_keeps_serving` and
`drive::tests::flush_buffers_flushes_open_files`.

### Upstream review

Upstream `crates/ironrdp-rdpdr` was reviewed up to IronRDP
[`62246b36`](https://github.com/Devolutions/IronRDP/commit/62246b364a0282bab85087f658a81fe4207b6b31)
(2026-10-16, [#4461]); no `ironrdp-rdpdr` release after 0.7.0 exists yet. Nothing
was ported: the newer commits are features (filesystem / smartcard / printer
backends, the bidirectional PDU layer and `RdpdrServer`), error byte offsets that
need a newer `ironrdp-core`, and the toolchain bump. The one fix, `476e8a17`
(consume the `DR_DRIVE_QUERY_INFORMATION_REQ` `Length`, padding and
`QueryBuffer`), matters only for the bidirectional layer that decodes several
PDUs from one cursor; in 0.7.0 the request is decoded from its own channel
message and the trailing bytes are never read, so porting it would only add
strictness.

Reviewed again up to IronRDP
[`4cd9d4506`](https://github.com/Devolutions/IronRDP/commit/4cd9d45060df01c731f5d814537ecd86d425190d)
(2026-11-09, [#4923]), covering the 0.8.0 and 0.9.0 releases. Ported: `4cd9d4506`
(change 2) and, as the follow-up [#5118], `0f9154d2` (change 3). Not ported:

- `29fc63da` (serve IRPs for devices awaiting their announce response) and `e88e3c51`
  (defer a User Logged On that arrives before the Client ID Confirm): both fix state
  checks master added after 0.7.0; 0.7.0 serves every listed device and has no such
  check, so neither bug exists here.
- `b69cda22` / `7fc80c4d` (`read_padding!` bounds): the rdpdr sites are the server-side
  Query Directory response decoder and the smartcard `AccessStartedEvent` call; the
  sidecar decodes neither (it announces only a drive).
- Features (`8575afc3` printers, `b735d190` WinSCard smartcards, `850839f4` serial and
  parallel ports) and the release commits (`e899a826`, `b13befa0`).

Retire the fork once an `ironrdp-rdpdr` release contains `for_drive` and `4cd9d4506`
(the next release after 0.9.0 should have both; `0f9154d2` and `d1c63ecd7b` are already in 0.9.0).
Change 4's unknown-MajorFunction fallback is not upstream: check the release still fails such a
request before retiring, and keep the sidecar test as the guard. The status, prepared upstream
text and retirement steps are in [`UPSTREAM.md`](UPSTREAM.md).

[#4125]: https://github.com/armaxri/termiHub/issues/4125
[#4461]: https://github.com/armaxri/termiHub/issues/4461
[#4923]: https://github.com/armaxri/termiHub/issues/4923
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

[IronRDP]: https://github.com/Devolutions/IronRDP
