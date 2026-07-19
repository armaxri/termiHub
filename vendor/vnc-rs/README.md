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

Everything else is upstream `0.5.3`, under the original MIT/Apache-2.0 licenses
(`LICENSE-MIT`, `LICENSE-APACHE`).
