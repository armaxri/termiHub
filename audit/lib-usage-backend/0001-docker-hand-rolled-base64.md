---
id: LIBBE-001
title: Replace hand-rolled base64 encoder/decoder in the Docker backend with the base64 crate
angle: lib-usage-backend
severity: medium
category: reliability
is_workaround: false
subsystem: core/backends/docker
evidence:
  - core/src/backends/docker/file_browser.rs:381
  - core/src/backends/docker/file_browser.rs:412
  - core/src/backends/docker/file_browser.rs:478
status: open
---

## What
The Docker file browser hand-rolls a base64 encoder and a byte-level base64
decoder (~100 lines), explicitly commented as a "no-dependency implementation":

```rust
/// Base64 encode bytes to a string (no-dependency implementation).
fn base64_encode(data: &[u8]) -> String { … }              // :382

/// Create a base64 decoding reader (no-dependency implementation).
fn base64_decode_reader(input: &[u8]) -> Base64Decoder<'_> { … }  // :413
struct Base64Decoder<'a> { … }                              // :423
impl std::io::Read for Base64Decoder<'a> { … }              // :431
fn decode_b64_char(b: u8) -> Option<u8> { … }               // :478
```

These move file **content** across the `docker exec` boundary: content is
base64-encoded to be shipped into the container, and the container's base64
output is decoded back on read.

## Why it matters
- **The `base64` crate is already a dependency.** It is a non-optional dependency
  of both `src-tauri` (`base64 = "0.22"`) and `agent`, so it is already compiled
  into every shipping build and present in `Cargo.lock`. The "no-dependency"
  justification is stale — adopting it costs one line in the `docker` feature list,
  no new supply-chain surface, and no cargo-deny churn. (`data-encoding` is also
  already in-tree behind the `ssh` feature.)
- **The hand-rolled decoder is lenient in a way a hardened crate is not.**
  `Base64Decoder::read` skips any byte that is neither a base64-alphabet
  character nor `=` (see the `if let Some(val) = decode_b64_char(b) … else if b ==
  b'='` branch at :451-458, with no `else` arm). Stray/injected bytes in the
  exec output are silently dropped instead of surfacing a decode error, so
  corruption can pass through as "successfully decoded" file content. This is data
  crossing a process boundary — exactly where a battle-tested decoder's strict
  error handling earns its keep.
- It is untested against the awkward cases a real codec covers (embedded
  whitespace/newlines in wrapped base64, non-canonical padding, invalid trailing
  bits).

## Evidence
`core/src/backends/docker/file_browser.rs:381-487`. The encoder is a standard
3-byte→4-char loop; the decoder is a custom `std::io::Read` state machine. Both
are the canonical "reinvented wheel" the repo's own coding standard warns against
("'I could write this in 50 lines' is not a reason to skip a library").

## Recommendation
**adopt-existing.** Add `dep:base64` to the `docker` feature in `core/Cargo.toml`
and replace:
- `base64_encode(data)` → `base64::engine::general_purpose::STANDARD.encode(data)`.
- the `Base64Decoder` `Read` adapter → decode the collected output with
  `STANDARD.decode(...)` (or wrap with `base64::read::DecoderReader` if a streaming
  `Read` is genuinely required), propagating the decode error instead of silently
  skipping bytes.

Keep the existing unit tests (`base64_roundtrip`, `base64_roundtrip_binary`) as a
regression net over the swap; add one case asserting that a non-alphabet byte now
produces an error rather than being dropped.
</content>
