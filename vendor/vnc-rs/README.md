# vnc-rs (termiHub vendored fork)

Vendored fork of [`vnc-rs`](https://github.com/HsuJv/vnc-rs) `0.5.3`, an async
client-side implementation of the VNC/RFB protocol.

## Why this is vendored

Upstream `0.5.3` (and its `main`) cannot negotiate **VeNCrypt** (RFB security
type 19): the connector hard-errors on any security type other than
`None`/`VncAuth`, and `VncClient::new` is `pub(super)`, so a
manually-driven VeNCrypt+TLS handshake cannot be handed back to resume the
session. This is a crate-API limitation, not a crypto-stack conflict.

See [armaxri/termiHub#1714](https://github.com/armaxri/termiHub/issues/1714).

## What this fork changes

- Adds VeNCrypt 0.2 client negotiation over TLS behind the **`vencrypt`** feature
  (`src/client/vencrypt.rs`), reusing termiHub's in-tree rustls stack
  (`tokio-rustls`). Supported sub-types: `X509None`/`X509Vnc`/`X509Plain`
  (260–262) and `Plain` (256). The anonymous-TLS sub-types (257–259) require
  anonymous ciphers that rustls does not support and are not negotiated.
- Adds `VncConnector::set_vencrypt(...)` to opt a connection into VeNCrypt.
- Adds `VncError::Vencrypt` / `VncError::Tls` variants.
- Makes the standard RFB clipboard encoding-correct and bounded (PROD-021,
  `src/client/messages.rs`): `ServerCutText` is decoded as UTF-8 when valid and
  as Latin-1 (the RFB-specified encoding) otherwise, instead of
  `from_utf8_lossy`; `ClientCutText` is sent as Latin-1 when every character is
  representable and as UTF-8 otherwise; and a `ServerCutText` longer than
  `MAX_SERVER_CUT_TEXT_BYTES` (16 MiB) is skipped in bounded chunks rather than
  allocated (surfaced as `ServerMsg::ServerCutTextDropped`). The Extended
  Clipboard pseudo-encoding (UTF-8 / rich formats) is **not** implemented.
- Drops the GUI dev-dependency (`minifb`) and the doctest example that used it so
  the crate builds as a workspace member without system GUI libraries.

## Hardening against hostile servers (#3473)

A VNC server — buggy or hostile — must never be able to panic the client or make
it allocate unbounded memory. Upstream `0.5.3` did both; this fork changes:

- **`SetColorMapEntries`** (`src/client/messages.rs`): parsed and discarded
  (`ServerMsg::SetColorMapEntries`), consuming its `6 x number-of-colors` bytes
  through a fixed buffer, instead of `unimplemented!()`.
- **Pixel formats** (`src/codec/mod.rs`): the RGBA-emitting decoders share a
  checked `alpha_shift` / `pixel_mask` (no `<<` overflow for server shifts, no
  `unreachable!()` for non-32-bpp formats). Tight returns
  `VncError::WrongPixelFormat`; the cursor pseudo-encoding consumes its payload
  and skips the shape.
- **Encodings** (`src/config.rs`, `src/client/connection.rs`): an encoding number
  the client does not implement is `VncError::UnsupportedEncoding` instead of
  being silently decoded as Raw (which desynchronised the stream).
- **Geometry and lengths**: every pixel-carrying rectangle (and a CopyRect source)
  must fit the 16-bit coordinate space and stay within `MAX_RECT_PIXELS`
  (8192 x 8192); ZRLE/TRLE length prefixes are bounded by `MAX_ENCODED_BYTES`;
  the `ServerInit` desktop name by 64 KiB; RFB/VeNCrypt failure reasons are read
  length-bounded (`auth::read_reason`) instead of `read_to_string` to EOF. All
  violations are `VncError::Protocol`.
- **Decoders**: Tight/ZRLE/TRLE palette indexes and RLE runs are bounds-checked
  (`VncError::InvalidImageData`), the TRLE/ZRLE tile cursor no longer overflows
  `u16` on 65535-row rectangles, a Tight one-colour palette is byte-indexed, a
  zlib stream slot emptied by an earlier failure is an error rather than an
  `unwrap()`, and the uninitialised-buffer helper and `unsafe` pixel copies were
  replaced with zeroed / bounds-checked equivalents.
- **Task boundary**: the internal decoder and connection tasks run behind a
  `catch_unwind` (`run_guarded`); a panic is logged and reported as
  `VncEvent::Error` (as `VncError::Internal`) so the consumer ends the session
  cleanly.
- **Typed error event** (#3479): `VncEvent::Error` carries the typed
  `Arc<VncError>` instead of its rendered text, so the consumer can tell a server
  protocol violation from a transport failure without parsing messages.
- Adds `VncError::Protocol` / `VncError::UnsupportedEncoding` /
  `VncError::Internal`. Regression and
  seeded fuzz tests live in `src/client/hostile_server_tests.rs`.

## Upstream fixes ported from vnc-rs 0.6.0 (#3499)

Reviewed upstream up to [`99ed1a2`](https://github.com/HsuJv/vnc-rs/commit/99ed1a28553c7594212adf30b9517d57fe46558d)
(release **0.6.0**, 2026-09-22). The fork base stays **0.5.3**
(`f8ac0ee4915e8e1e1adb8880a0716761b91281f6`): upstream's 20 commits rewrite the
same files as the #3473 hardening (connection loop, all codecs) and add a
~1000-line desktop-resize feature and a new public event, so re-basing would
mean re-porting all of our delta for no security gain. Ported instead, each
marked `#3499` in the source:

- **Handshake** (`b266a3f`, `6adeb0d`): `SecurityResult` is range-checked
  (upstream transmuted any `u32` into a two-variant enum — undefined behaviour);
  `SecurityType` uses an explicit match; an RFB 3.3 security type is checked
  _before_ narrowing to `u8` (`257` read as `1`, None); unknown offered types are
  skipped and an empty list is `VncError::Protocol` instead of an `assert!`; RFB
  3.8 None-auth reads and honours its `SecurityResult`; a failed VncAuth on 3.3
  no longer reads a reason 3.3 never sends. Reason and desktop-name bounds drop
  from 64 KiB to upstream's 4 KiB.
- **Pixel formats** (`1c07e2c`): wire booleans are normalised to 0/1 and
  `PixelFormat::validate` (2^n-1 maxima, shifts inside the pixel, no
  overlapping masks) runs in `VncConnector::build` and when the server's format
  is adopted. Tight also requires three 8-bit channels (`129e7c9`).
- **Geometry** (`623b894`): rectangles must use an encoding the client sent in
  `SetEncodings` (Raw always allowed) and lie inside the current framebuffer,
  tracked through `DesktopSize`; framebuffer sides are capped at 8192.
- **Tasks and queues** (`dea233d`, `6acf3da`): the stop signal cancels a
  decoder blocked mid-message and a blocked socket write; the network bridge
  reserves capacity inside the select, so it wakes when the decoder frees a slot
  (upstream could park forever with data pending); exit drops the bridge
  instead of awaiting an EOF send into a full queue; `VncClient::input` no longer
  holds the client mutex across backpressure (which could deadlock `close` and
  `poll_event`); decoder errors are delivered racing the stop signal.

Kept stricter or deliberately different from upstream: the 8192 x 8192 area
bound (`MAX_RECT_PIXELS`, upstream caps at 3840 x 2160 and would refuse 5K/8K
desktops), zero-sized rectangles stay legal, the 16 MiB skip-not-fail
`ServerCutText` bound, and `MAX_ENCODED_BYTES`. Upstream's run-length /
palette-index / zlib-slot fixes (`129e7c9`) were already covered by #3473.
The event-queue size stays 4096 (upstream: 2) because termiHub's driver drains
it on a 30 ms tick; bounding it by memory is follow-up
[#3511](https://github.com/armaxri/termiHub/issues/3511).

Not ported (features or tooling): desktop resizing (`cc4472d`, `6528704`,
`46934f4`), exposing the desktop name (`f2dcc3c`), the cargo-fuzz harness
(`ce7c4ee`; the seeded fuzz test in `hostile_server_tests.rs` covers the same
parsers), version/author/CI bumps and merge commits. Regression tests are in
`src/client/upstream_060_tests.rs`, `hostile_server_tests.rs`,
`connection.rs`, `config.rs` and `codec/mod.rs`.

Everything else is upstream `0.5.3`, under the original MIT/Apache-2.0 licenses
(`LICENSE-MIT`, `LICENSE-APACHE`).
