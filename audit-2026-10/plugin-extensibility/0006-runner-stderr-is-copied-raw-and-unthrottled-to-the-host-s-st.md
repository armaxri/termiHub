---
id: PLG2-006
title: "Runner stderr is copied raw and unthrottled to the host's stderr, bypassing the plugin log limiter, and a plugin can spoof the out-of-memory exit classification"
angle: plugin-extensibility
severity: low
category: robustness
is_workaround: false
subsystem: "core/src/plugin/sandbox/peer.rs"
evidence:
  - core/src/plugin/sandbox/peer.rs:154
  - core/src/plugin/sandbox/peer.rs:162
  - core/src/plugin/sandbox/peer.rs:165
  - core/src/plugin/sandbox/peer.rs:494
status: fixed
resolution: "#4335 — runner stderr goes through the plugin log limiter, tagged and stripped of control characters; its OOM marker counts only with host-side evidence"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`Shared::forward_stderr` reads the runner's stderr in 16 KiB line pieces and writes every byte straight to `std::io::stderr()`. It applies no rate limit, no control-character sanitising and no plugin-id prefix. The structured `Log` frames, by contrast, are bounded and go through `PluginLogLimiter` and `emit_runner_log`. Any stderr line matching `memory allocation of N bytes failed` also sets `out_of_memory`, which `finish()` and `prefer_memory_evidence` use to reclassify the exit.

## Why it matters

The runner is explicitly an untrusted peer, but this channel is the one place where its output reaches the host without bounds. A plugin can flood the host's stderr, which on Linux desktop sessions is typically the user's journald, and inject terminal escape sequences without attribution. It can also turn a hang verdict into 'out of memory', so the status UI and auto-disable reason show a misleading cause. The impact is limited to diagnostics and logs.

## Recommendation

Route stderr lines through the same `PluginLogLimiter` (`emit_runner_log` at Warn with the plugin id), with control characters stripped. Accept the OOM evidence only when it agrees with host-side measurement, for example the `near()` memory-pressure check the watchdog already has, instead of trusting the runner's text alone.

## Verification

Confirmed. peer.rs:154-170 forward_stderr writes each line, up to MAX_STDERR_LINE, straight to std::io::stderr() with no rate limit, sanitising or plugin-id prefix, and sets out_of_memory from text matching alone. prefer_memory_evidence (line ~571) turns NotResponding into OutOfMemory on that flag. The impact is limited to diagnostics and logs, as stated.
