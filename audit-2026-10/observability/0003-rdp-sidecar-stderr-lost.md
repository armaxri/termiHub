---
id: OBS2-003
title: "RDP sidecar logs and panics go to an inherited stderr that is lost in the bundled app"
angle: observability
severity: medium
category: observability-gap
is_workaround: false
subsystem: "core/src/backends/rdp_sidecar, rdp-sidecar/src"
evidence:
  - core/src/backends/rdp_sidecar/mod.rs:82
  - core/src/backends/rdp_sidecar/mod.rs:188
  - rdp-sidecar/src/main.rs:45
  - rdp-sidecar/src/main.rs:46
  - rdp-sidecar/src/rdp.rs:850
  - rdp-sidecar/src/rdp.rs:879
  - rdp-sidecar/src/rdp.rs:942
status: open
resolution: ""
audit: 2026-10
commit: "663465d52"
relation: new
---

## What

The desktop spawns termihub-rdp-helper with `.stderr(Stdio::inherit())` (mod.rs:188), and the sidecar sends all of its tracing output to stderr (main.rs:46). It has no panic hook and no file sink. A bundled GUI app (Finder or Dock on macOS, GUI subsystem on Windows) has no stderr, so all of the sidecar's ~60 warn!/error! lines vanish. They never reach termihub.log, the LogViewer or the Export Diagnostics bundle. Some of these lines end the session. Example: 'clipboard event failed; ending the session' (rdp.rs:850) breaks out of the loop, so no typed Failure is sent and the desktop sees only an unexplained disconnect. The same applies to rdp process errors (:879) and deactivation-reactivation failures (:942). The plugin runner, by contrast, pipes stderr and forwards it through the host (core/src/plugin/sandbox/client.rs:98-103), and the stdio agent's stderr is parsed and re-emitted.

## Why it matters

RDP is a supported connection type. When a session drops or redirection (clipboard, drive, audio) fails, the only record of why is thrown away, so neither user nor support can diagnose it. A sidecar panic also leaves no crash report, which undercuts the OBS-002/OBS-010 crash-reporting coverage.

## Recommendation

Spawn the sidecar with `Stdio::piped()` for stderr. Forward each line into the desktop's tracing pipeline under a dedicated target such as `termihub_rdp_sidecar`, with a size cap and sanitizing, the same way agent_stderr.rs and the plugin stderr forwarder do. Optionally switch the sidecar to the agent's framed log_frame format so levels are preserved. Install the shared core panic-hook/crash_report in the sidecar, or at least log the panic to stderr so it gets forwarded. Send a typed Failure before the clipboard-error break so the host records the reason.

## Verification

Confirmed. rdp_sidecar/mod.rs spawns the helper with `.stderr(Stdio::inherit())`. The sidecar main sends tracing only to stderr and installs no panic hook or file sink. rdp.rs:850 logs a warn and then breaks out of the loop when clipboard handling fails, without sending a typed failure. A bundled GUI app's stderr goes nowhere useful.
