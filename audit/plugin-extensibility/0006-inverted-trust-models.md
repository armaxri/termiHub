---
id: PLG-006
title: Inverted trust models — privileged native plugin gated only by an install ack; sandboxed JS is default-off
angle: plugin-extensibility
severity: high
category: security
is_workaround: false
subsystem: core/src/plugin, src/plugins
evidence:
  - core/src/plugin/capabilities.rs:43
  - core/src/plugin/security.rs:329
  - src/components/Settings/FrontendPluginGateSettings.tsx:22
  - core/src/plugin/host.rs:258
status: open
---

## What
termiHub has **two** things called "plugins" with opposite trust postures, and the
postures are inverted relative to the actual risk:

| | Native `terminalBackend` | Frontend JS (`protocolParser`/`statusBarWidget`) |
|---|---|---|
| Runs where | **in the host process**, native code | Web Worker sandbox (no DOM/window/IPC) |
| Privilege | **full app privileges**; the capability bridge is *cooperative* and trivially bypassable (`std::net`, `std::fs` directly) | least-privilege, host-mediated |
| Enable gate | installs behind a one-time untrusted-source **acknowledgement**, then loads automatically | **default-off** experimental opt-in with a prominent warning |

So the *more* dangerous plugin type (arbitrary native code, in-process, full
privilege) has the *weaker* gate (an install-time checkbox), while the *less*
dangerous one (sandboxed JS with no IPC) is the one hidden behind a default-off
switch. The `capabilities.rs` module itself documents that the bridge "is **not** an
OS sandbox — a malicious plugin could still call `std::net::TcpStream::connect` or
`std::fs::read` directly and bypass the bridge entirely."

## Why it matters
This is the strategic question for whether a native-plugin *ecosystem* is tenable at
all. Signing (PLG covered by security expert) proves provenance and integrity but
does nothing to constrain what a trusted-but-buggy or trusted-then-compromised
plugin does once loaded — it is arbitrary in-process code. For a safety-critical
release that will ship an "install plugins" affordance, the default posture is:
"click through one warning, then run arbitrary native code with the app's full
authority, including its stored credentials and open sessions." The careful bridge,
permission set, and filesystem scoping are all **cooperative** — they constrain only
plugins that choose to route through them.

Meanwhile the genuinely-sandboxed path (frontend JS) is the one treated as too risky
to enable by default. The risk assessment is upside down.

## Evidence
- `core/src/plugin/capabilities.rs:43-53` — explicit "not an OS sandbox … could
  bypass the bridge entirely" caveat.
- `core/src/plugin/security.rs:329-334` — the only native gate is the unsigned-
  source warning string; nothing gates *loading* a signed native plugin.
- `core/src/plugin/host.rs:258-289` + `manager.rs:load_enabled_plugins` — an enabled
  native plugin is `dlopen`ed and run at startup with no per-run user consent.
- `src/components/Settings/FrontendPluginGateSettings.tsx:22-24` — the sandboxed JS
  path is `?? false` (default-off) behind an experimental toggle.

## Recommendation
Frame and decide the trust model explicitly before release:
- **Short term (v0.1):** gate native-plugin *loading* behind the same kind of
  explicit, default-off experimental opt-in the frontend plugins already have —
  arbitrary in-process native code should not run on a one-time install checkbox.
- **Medium term:** for an actual ecosystem, native backends need **out-of-process
  isolation** (a child process speaking the JSON-RPC agent protocol termiHub already
  has) or a **WASM** runtime, so the capability bridge becomes *enforced* rather than
  cooperative. The existing agent/daemon transport is a natural substrate: a plugin
  backend could be a sandboxed subprocess rather than an in-process `dlopen`.
- Document the current model honestly in `plugin-authoring.md`: today, installing a
  native plugin is equivalent to running an untrusted native binary with the app's
  authority.

(Cross-references the security expert's finding on native plugins running
in-process/unsandboxed; this entry is the extensibility/strategy framing of that
soundness fact.)
