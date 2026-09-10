---
id: CORE-008
title: VNC framebuffer allocates from unbounded server-controlled dimensions (DoS / abort)
angle: backend-core-rust
severity: high
category: reliability
is_workaround: false
subsystem: core/backends/vnc
evidence:
  - core/src/backends/vnc/mod.rs:377
  - core/src/backends/vnc/mod.rs:397
status: open
---

## What
`FrameShadow::resize` is driven directly by server-supplied dimensions with no
upper bound, and for `RawImage` the resize happens **before** the payload-size
sanity check:

```rust
VncEvent::SetResolution(screen) => {
    shadow.resize(screen.width as u32, screen.height as u32);
...
VncEvent::RawImage(rect, data) => {
    ...
    if shadow.width() == 0 || shadow.height() == 0 {
        shadow.resize(x + w, y + h);   // resize before validation
    }
    if data.len() != (w as usize) * (h as usize) * 4 {
```

`resize` does `vec![0u8; width*height*4]`.

## Why it matters
The VNC server is a remote, potentially hostile peer. A `SetResolution(65535, 65535)`
forces a ~17 GB zeroed allocation; Rust aborts the whole process on allocation
failure (no catchable error), so a single crafted RFB message crashes the app.
The `RawImage` path resizes to `x+w`/`y+h` before the `data.len()` check, so the
size guard cannot prevent the oversized allocation. The mock backend already
clamps to `MAX_DIMENSION` via `clamp_dim`; the real VNC path does not.

## Evidence
`core/src/backends/vnc/mod.rs:376-408`. Contrast the mock backend
(`mock_remote_desktop.rs`) which clamps dimensions.

## Recommendation
Clamp all server-supplied `width`/`height` (and `x+w`, `y+h`) to a sane maximum
(e.g. 8192×8192) before any `resize`, dropping or erroring on oversized values —
reuse the mock's `clamp_dim` approach. Validate `data.len()` against the clamped
rect before allocating.
