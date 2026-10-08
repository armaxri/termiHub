---
id: PERF2-001
title: "Remote-desktop frames cross IPC as JSON number arrays of raw RGBA pixels"
angle: performance
severity: high
category: perf
is_workaround: false
subsystem: core/src/connection/graphical.rs, src-tauri/src/session/graphical_manager.rs, src/components/RemoteDesktop
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
evidence:
  - core/src/connection/graphical.rs:213
  - core/src/connection/graphical.rs:218
  - src/types/generated/DirtyRect.ts
  - src-tauri/src/session/graphical_manager.rs:56
  - src-tauri/src/session/graphical_manager.rs:175
  - src-tauri/src/session/graphical_manager.rs:1229
  - src/services/events.ts:100
  - src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:255
  - core/src/backends/vnc/budget.rs:30
---

## What

`DirtyRect.data` is a `Vec<u8>` of tightly packed RGBA. It is serialized with serde's default encoding, a JSON array with one number per byte. The doc comment (graphical.rs:215) and the generated TS type `data: Array<number>` both say so. Every VNC/RDP frame update goes out as a `remote-desktop-frame` Tauri event with this payload (graphical_manager.rs:175). The frontend gets a JS array of numbers, copies it into `new Uint8ClampedArray(rect.data)`, and then into `ImageData` (RemoteDesktopCanvas.tsx:255). Cursor shapes (`CursorShape`, also `Array<number>`) use the same encoding. This is the number-array IPC anti-pattern that PERF-002 and PERF-009 removed from the editor and scrollback paths, now in the subsystem with the most data.

## Why it matters

One byte becomes about 3–4 JSON characters, and each pixel has 4 bytes. A full 1920x1080 frame is 8.3 MB of RGBA, which becomes about 28–33 MB of JSON. Tauri 2 embeds that in a script the webview has to evaluate. JS then holds an 8.3M-element array (about 8 bytes per element), and that is copied twice more. Full frames are common: request_full_frame on every subscribe, reconnect, window scroll, video, and Fit/Match resizes. The VNC queue budget allows up to 256 MiB of queued frames (budget.rs:30). The result is multi-hundred-MB heap spikes, long main-thread stalls, and very low frame rates. This is a core flow of the remote-desktop feature.

## Evidence

- `core/src/connection/graphical.rs:213`
- `core/src/connection/graphical.rs:218`
- `src/types/generated/DirtyRect.ts`
- `src-tauri/src/session/graphical_manager.rs:56`
- `src-tauri/src/session/graphical_manager.rs:175`
- `src-tauri/src/session/graphical_manager.rs:1229`
- `src/services/events.ts:100`
- `src/components/RemoteDesktop/RemoteDesktopCanvas.tsx:255`
- `core/src/backends/vnc/budget.rs:30`

## Recommendation

Stop putting pixel data in JSON events. Best option: stream frames over a `tauri::ipc::Channel<InvokeResponseBody::Raw>` (or return `tauri::ipc::Response` from a pull command) as a binary ArrayBuffer, with a small header (x, y, w, h) per rect. Minimum option: `#[serde(with = "base64")]` on `DirtyRect.data` and `CursorShape` data, decoded with the existing `base64ToBytes` straight into a Uint8ClampedArray, as #2072/#3007 did. Also consider sending encoded rects (the VNC backend already has a jpeg module) and decoding them with `createImageBitmap`. Add a wire-format test like the scrollback base64 round-trip test.

## Verification

I checked the evidence and it holds. `DirtyRect.data` is a plain `Vec<u8>` with no serde attribute (core/src/connection/graphical.rs:218). Its doc comment says it is "Serialized as a JSON array of bytes", and the generated TS type is `data: Array<number>`. `emit_frame` sends `RemoteDesktopFrameEvent` (FrameUpdate flattened in) through `app.emit`/`emit_to`, which is the JSON event path (graphical_manager.rs:175, :1229). RemoteDesktopCanvas.tsx:255 builds `new Uint8ClampedArray(rect.data)` from that JS number array. No path anywhere uses base64, a binary ipc::Channel, or a Response for frames; the only `tauri::ipc::Channel` use is for projection. FrameGuard checks frames but does not change the encoding or throttle the data, and I found no open issue tracking this. Nothing in architecture.md or the ADRs makes this a deliberate choice. In fact core/src/backends/rdp_sidecar/protocol.rs:31 picks MessagePack precisely because JSON does not keep the frame `Vec<u8>` packed, so the team knows the cost and only fixed it on the sidecar hop. The doc comment's "keep rects small" is just a hope: full-frame requests and resizes still send framebuffer-sized rects, and budget.rs allows up to 256 MiB of queued frames. One 1080p full frame is about 8 MB of RGBA and becomes roughly 30 MB of JSON plus large JS array copies. That is a real throughput and memory problem in the main remote-desktop flow, so I keep severity at high. The fix is self-contained: base64 or a binary channel.
