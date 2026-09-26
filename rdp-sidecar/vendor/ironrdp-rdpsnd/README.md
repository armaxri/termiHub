# IronRDP RDPSND (termiHub vendored fork)

RDPSND static channel for audio output implemented as described in [MS-RDPEA].

This crate is part of the [IronRDP] project.

## termiHub vendored fork

This is a vendored fork of `ironrdp-rdpsnd` **0.9.0** for termiHub's RDP sidecar
(see [`termiHub#1773`](https://github.com/armaxri/termiHub/issues/1773)). It is
patched into the workspace-excluded `rdp-sidecar` crate via `[patch.crates-io]`,
mirroring how `vendor/vnc-rs` is patched into the main app.

There are **two functional changes** of our own plus **upstream fixes ported
from after 0.9.0** (see below), all in `src/client.rs`.

### 1. `wave` receives the concrete `AudioFormat` ([#1773])

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

### 2. `accepts_format` for server-chosen compressed formats ([#1812])

Multi-rate PCM negotiates fine by structural equality because PCM formats are
canonical (the client can reproduce the server's exact `AudioFormat`). Compressed
formats cannot: the server picks the block layout (`n_block_align`,
`wSamplesPerBlock`, and — for MS-ADPCM — the coefficient `data`), which the client
cannot predict, so the exact-equality intersection can _never_ select an ADPCM
format however many the handler advertises.

- This fork adds `RdpsndClientHandler::accepts_format(&self, &AudioFormat) -> bool`
  (default: `get_formats().contains(format)`, i.e. the prior exact-match behaviour)
  and rewrites `client_formats()` to iterate the **server's** advertised formats in
  order and keep the ones the handler accepts, echoing each accepted server format
  back **verbatim**. A handler that decodes a codec regardless of block layout
  overrides `accepts_format` to accept it; because the echoed format is the
  server's own, `wave` then receives concrete, decodable block parameters. The
  returned list is also now deterministic (server order) where the `HashSet`
  intersection was not.

### 3. Upstream fixes ported after 0.9.0 ([#3499])

Reviewed upstream `crates/ironrdp-rdpsnd` up to IronRDP
[`160752fc`](https://github.com/Devolutions/IronRDP/commit/160752fcf3293889f1ce1bdd3d2e7afc790a9cd2)
(2026-08-31); the fork base stays 0.9.0 (tag `ironrdp-rdpsnd-v0.9.0`, `11a0810cf`).

- **Malformed PDUs are ignored** (upstream `c87ab68e`, "isolate malformed
  encrypted waves"): a server audio PDU that fails to decode is logged and
  dropped, keeping the channel state, instead of returning the decode error —
  which the session treats as fatal, so one bad RDPSND PDU ended the whole
  desktop connection.
- **Unsupported optional PDUs keep the channel alive** (from upstream
  `2d9a9bf1`): `CryptKey` / `WaveEncrypt` in the Ready state are logged and
  ignored instead of stopping audio for the rest of the session.
- **`get_format(format_no)` indexes the negotiated client list** (from upstream
  `2d9a9bf1`), matching MS-RDPEA; 0.9.0 indexed the server's list.

Deliberately **not** ported: pre-v8 `WaveInfo` + bare `Wave` playback (feature,
upstream `2d9a9bf1`; follow-up [#3510]), upstream's own
client-format ordering (superseded by change 2 above), quality-mode selection
(`14ef4fd4`), error byte offsets (`8607ac5d`, needs a newer `ironrdp-core`),
the AUDIO_INPUT helper (`50fa88b2`), server-side wave timestamps/confirms
(`160752fc`, server only) and the toolchain bump (`0aeea76e`). Regression tests
live in `rdp-sidecar/src/rdpsnd_fork_tests.rs` (this crate builds with
`test = false`).

`pdu.rs`, `server.rs` and `lib.rs` are byte-for-byte upstream 0.9.0. The intended
upstream contribution is changes 1 and 2. Sibling `ironrdp-*` deps
remain registry versions so nothing else forks.

[#1773]: https://github.com/armaxri/termiHub/issues/1773
[#1812]: https://github.com/armaxri/termiHub/issues/1812
[#3499]: https://github.com/armaxri/termiHub/issues/3499
[#3510]: https://github.com/armaxri/termiHub/issues/3510
[IronRDP]: https://github.com/Devolutions/IronRDP
[MS-RDPEA]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/bea2d5cf-e3b9-4419-92e5-0e074ff9bc5b
