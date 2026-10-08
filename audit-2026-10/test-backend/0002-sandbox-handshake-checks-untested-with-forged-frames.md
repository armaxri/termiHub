---
id: TBE2-002
title: "The host's handshake checks on the untrusted runner have no test with forged frames"
angle: test-backend
severity: medium
category: test-gap
is_workaround: false
subsystem: core/plugin/sandbox client
evidence:
  - core/src/plugin/sandbox/client.rs:412
  - core/src/plugin/sandbox/client.rs:418
  - core/src/plugin/sandbox/client.rs:435
  - core/src/plugin/sandbox/client.rs:438
  - core/src/plugin/sandbox/client.rs:450
  - core/src/plugin/sandbox/client.rs:454
  - core/tests/plugin_runner_e2e.rs:184
  - core/tests/plugin_runner_e2e.rs:230
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

`handshake<S: ChannelStream>` (client.rs:412-473) is where the host refuses to trust the runner. It checks the Hello protocol version. It requires a SandboxReport before Loaded and validates it against the requested policy via `policy::check_report` (client.rs:435-440). It also re-runs the ABI gate and manifest mirror on the `Loaded` frame, because 'the host does not take an untrusted peer's word for it' (client.rs:450-457). The `Loaded` frame is sent after the plugin's init code has run inside the runner, so a malicious plugin can forge it.

The function is generic over the stream, which makes it unit-testable, yet a repo-wide search finds no test that feeds it forged frames: no protocol-version mismatch, no Loaded without a SandboxReport, no report claiming fewer layers than requested, no Loaded with an ABI/manifest mismatch, no Hello timeout. The e2e tests cover only a process that exits before Hello and a library the honest runner itself refuses (plugin_runner_e2e.rs:184,230). `check_report` and `check_library_abi` are unit-tested in isolation, but nothing shows the handshake actually calls them in the right order or kills the runner on failure.

## Why it matters

This is the only host-side defence against a compromised runner claiming a sandbox it did not apply, or an ABI it does not have. A refactor that, for example, accepts `Loaded` directly, or checks the report only when `accept_reduced_isolation` is false, would keep every current test green and silently run an unconfined plugin.

## Recommendation

Add unit tests in core/src/plugin/sandbox (a `client_tests.rs`) that drive `handshake` over an in-memory `ChannelStream` scripted with forged runner frames. Cases: wrong `protocol_version`; `Loaded` before `SandboxReport`; a `SandboxReport` missing a required layer while `configure.sandbox` is set; a `Loaded` whose `abi_version` exceeds the host's or mismatches `manifest_api_version`; and a stream that never sends Hello (with a short injected timeout). Each must return the specific `HostError` variant. Add one e2e case with a fake runner binary (or a test-only runner flag) that sends a forged Loaded, and assert that the process is killed and the plugin is not registered.

## Verification

Confirmed: handshake<S: ChannelStream> (client.rs:412-473) has no unit test. client.rs has no #[cfg(test)] module, its only caller is client.rs:109, and neither plugin_runner_e2e.rs nor plugin_runner_sandbox.rs feeds forged frames (version mismatch, Loaded before SandboxReport, under-reporting report, ABI-mismatched Loaded). check_report and check_library_abi are only tested in isolation. This is a real test gap on a security boundary.
