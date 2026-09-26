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
  `VncEvent::Error` so the consumer ends the session cleanly.
- Adds `VncError::Protocol` / `VncError::UnsupportedEncoding`. Regression and
  seeded fuzz tests live in `src/client/hostile_server_tests.rs`.

Everything else is upstream `0.5.3`, under the original MIT/Apache-2.0 licenses
(`LICENSE-MIT`, `LICENSE-APACHE`).
