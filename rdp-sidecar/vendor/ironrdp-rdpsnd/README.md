# IronRDP RDPSND (termiHub vendored fork)

RDPSND static channel for audio output implemented as described in [MS-RDPEA].

This crate is part of the [IronRDP] project.

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpsnd` **0.9.0** for termiHub's RDP sidecar
(see [`termiHub#1773`](https://github.com/armaxri/termiHub/issues/1773)). It is
patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`,
mirroring how `vendor/vnc-rs` is patched into the main app.

**The only functional change** (in `src/client.rs`) makes the client `wave`
callback receive the concrete negotiated `AudioFormat` instead of a bare
`format_no` index:

- Upstream `Rdpsnd::client_formats()` built the Client Audio Formats list from a
  `HashSet` intersection — non-deterministically ordered — and then discarded it,
  handing the handler only `wave(format_no, ..)`, an index into a list the handler
  can neither see nor order. With more than one advertised format that index is
  unresolvable, so a client advertising several PCM rates could not tell which
  rate a `wave` buffer was in (risking "chipmunk" audio from playing e.g. 22.05
  kHz data at 44.1 kHz).
- This fork adds a `negotiated_formats: Vec<AudioFormat>` field to `Rdpsnd` that
  remembers the exact list sent, and changes the trait method to
  `RdpsndClientHandler::wave(&mut self, format: &AudioFormat, ts, data)`.

`pdu.rs`, `server.rs` and `lib.rs` are byte-for-byte upstream 0.9.0. The intended
upstream contribution is exactly this signature change. Sibling `ironrdp-*` deps
remain registry versions so nothing else forks.

[IronRDP]: https://github.com/Devolutions/IronRDP
[MS-RDPEA]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/bea2d5cf-e3b9-4419-92e5-0e074ff9bc5b
