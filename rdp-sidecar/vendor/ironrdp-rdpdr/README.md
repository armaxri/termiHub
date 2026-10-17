# IronRDP RDPDR (termiHub vendored fork)

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpdr` **0.7.0** for termiHub's RDP sidecar
(see [`termiHub#4125`](https://github.com/armaxri/termiHub/issues/4125)). It is
patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`,
exactly like `rdp-sidecar/vendor/ironrdp-pdu`. `ironrdp` re-exports the crate as
`ironrdp::rdpdr`, so the patch redirects that re-export too.

**Fork base:** upstream tag `ironrdp-rdpdr-v0.7.0`, commit
[`11a0810cfbbabd8b8023875a05e3041216d4b01b`](https://github.com/Devolutions/IronRDP/commit/11a0810cfbbabd8b8023875a05e3041216d4b01b)
of [IronRDP](https://github.com/Devolutions/IronRDP), copied from the crates.io
package. The fork is registered in
[`vendor/vendored-forks.json`](../../../vendor/vendored-forks.json), and a weekly CI
job reports upstream releases, commits and advisories that the fork does not have
yet — see `docs/supply-chain.md` → "Vendored forks". Update both when re-basing or
reviewing upstream again.

### The one change: name redirected drives in PreferredDosName ([#4125])

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
`DeviceData` is unchanged: the full name as null-terminated UTF-8, as in 0.7.0.

`for_drive` is a straight port of the function upstream added in
[`161409e18dd1`](https://github.com/Devolutions/IronRDP/commit/161409e18dd185de9bb30730303e56f5e8d28941)
("feat(rdpdr): add filesystem PDU foundation", IronRDP#1566), which landed on
master after 0.7.0 and is not yet released. That upstream commit also switched
`DeviceData` to UTF-16LE; the fork does **not** take that part, because Windows
hosts then expose the drive under its first letter only (IronRDP#2075, open). The
code changes are marked `termiHub fork delta (#4125)`, and `src/pdu/efs.rs` ends
with the fork's unit tests (`termihub_fork_tests`). `[lib] test = false` was
removed from `Cargo.toml` so they run: `cargo test -p ironrdp-rdpdr` from
`rdp-sidecar/`. The sidecar's own
`rdp::tests::drive_announce_carries_the_drive_name_in_preferred_dos_name` and the
live xrdp test RDP-15 (`core/tests/rdp.rs`) cover the fix from outside.
Everything else is byte-for-byte upstream 0.7.0, without the registry-only
`Cargo.lock`, `Cargo.toml.orig` and VCS metadata.

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

Retire the fork once an `ironrdp-rdpdr` release contains `for_drive` and keeps a
`DeviceData` encoding that works on Windows and xrdp. The status, prepared upstream
text and retirement steps are in [`UPSTREAM.md`](UPSTREAM.md).

[#4125]: https://github.com/armaxri/termiHub/issues/4125
[#4461]: https://github.com/armaxri/termiHub/issues/4461

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
