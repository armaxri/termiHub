---
id: MOCK-011
title: Graphical remote-desktop automated coverage runs only against the intentionally-bounded mock; real VNC/RDP oversize paths are never exercised
angle: test-mocking
severity: medium
category: test-gap
is_workaround: false
subsystem: core/backends/mock_remote_desktop, src-tauri/src/session/graphical_manager
evidence:
  - core/src/backends/mock_remote_desktop.rs:122
  - core/src/backends/mock_remote_desktop.rs:37
  - src-tauri/src/session/graphical_manager.rs:752
status: open
---

## What
Every automated test of the shared graphical pipeline (canvas / toolbar / overlay / input /
resize / reattach) connects the **mock** backend: `graphical_manager.rs` connects
`"mock-remote-desktop"` in its tests (`:752,794,831,870,935`), and no system/E2E test drives a
real VNC or RDP server (grep of `tests/system/tests/*.py` for graphical/remote-desktop →
nothing). The mock is deliberately **safer than any real protocol backend**:

```
# core/src/backends/mock_remote_desktop.rs:37,122
const MAX_DIMENSION: u16 = 1920;
fn clamp_dim(value: u16, default: u16) -> u16 { … v.min(MAX_DIMENSION) }
```

It clamps every requested framebuffer dimension into `1..=1920`, bounds its channels
(`CHANNEL_DEPTH = 16`), and drops rather than blocks. A real VNC (RFB) backend accepts a
server-advertised framebuffer size and allocates `w*h*4` from it — the unbounded-allocation
path TBE-003 documents. Because the clamp lives in the mock and the mock is the only backend
any automated lane exercises, **no test can reproduce the real oversize-alloc behavior**: the
double is safe exactly on the axis where reality is dangerous.

## Why it matters
- This is the mock-vs-reality "safer than reality" divergence at the integration level. The
  graphical E2E surface reports green against a backend that structurally cannot allocate a
  hostile framebuffer, so the shared canvas/decoder is never tested against the oversize,
  malformed, or backpressure-hostile frame streams a real VNC/RDP server can produce.
- Combined with MOCK-001 (the mock ships in the default build), the graphical feature's only
  routinely-exercised backend is a bounded stand-in — real-protocol robustness is verified, if
  at all, only on the release-cadence live lane against real containers (`tests/docker/
  vnc-server`, `vnc-vencrypt-server`), which do not gate PRs.

## Evidence
- Clamp + cap constants: `mock_remote_desktop.rs:37,42,122-128`.
- Tests connect only the mock: `src-tauri/src/session/graphical_manager.rs:752,794,831,870,935`.
- No graphical/remote-desktop system test: grep `tests/system/tests/*.py` → none.
- Real unbounded path documented separately: audit/test-backend TBE-003.

## Recommendation
Add per-PR unit tests of the shared graphical layer that feed **hostile frame streams**
directly (oversize `FrameUpdate`, dirty rects exceeding the framebuffer, a slow consumer to
force backpressure) — independent of any backend — so the decoder/canvas bounds are asserted
without needing a live server. Separately, promote the real-VNC container tests
(`tests/docker/vnc-server`) into a gating lane, or add a size-cap at the shared layer that the
mock and real backends both honor and that a test pins. The clamp belongs in shared
production code, not only in the test double.
