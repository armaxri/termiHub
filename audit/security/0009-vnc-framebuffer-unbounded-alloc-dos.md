---
id: SEC-009
title: VNC framebuffer allocation is driven by server-supplied resolution with no bound (memory DoS)
angle: security
severity: medium
category: security
is_workaround: false
subsystem: core/src/backends/vnc
evidence:
  - core/src/backends/vnc/frame.rs:47
  - core/src/backends/vnc/mod.rs:377
status: open
---

## What

The VNC shadow framebuffer is (re)allocated from a width×height supplied by the
**remote VNC server**, with no sanity cap:

```rust
// core/src/backends/vnc/frame.rs:44-47
pub fn resize(&mut self, width: u32, height: u32) {
    self.width = width; self.height = height;
    self.data = vec![0u8; (width as usize) * (height as usize) * 4];
}
```

The dimensions come straight off the wire — the RFB desktop-size / resolution
message (`core/src/backends/vnc/mod.rs:377` `shadow.resize(screen.width as u32,
screen.height as u32)`, and rect-driven resizes at `:351`/`:397`). RFB carries
these as `u16`, so a malicious or compromised server can declare 65535×65535 and
force a single ~17 GB zeroed allocation (and repeated resizes can do it
repeatedly).

## Why it matters

A hostile VNC server (in the threat model) can OOM-kill or freeze the desktop —
and, where VNC is proxied, the agent host — with one crafted message, before any
user interaction beyond connecting. It is a cross-trust-boundary,
attacker-controlled allocation with no ceiling. Denial of availability on a
safety-critical device is a safety concern in its own right.

## Evidence

- `core/src/backends/vnc/frame.rs:47` — `vec![0u8; w*h*4]` with no bound.
- `core/src/backends/vnc/mod.rs:377`, `:351`, `:397` — resolution/rect values from
  the server drive `resize()`; no `MAX_WIDTH`/`MAX_HEIGHT`/`MAX_PIXELS` check
  exists.

## Recommendation

Clamp/validate server-declared dimensions before allocating: reject (close the
connection with an error) any resolution beyond a sane ceiling (e.g. 8192×8192, or
a configurable max-pixels budget), and reject rects that exceed it. Use
`checked_mul` for the byte computation and treat overflow as an error. A single
`const MAX_VNC_PIXELS` guard at the top of `resize()` (and at the RFB parse site)
closes it. Add a regression test feeding an oversized resolution and asserting the
connection is refused rather than allocating.
