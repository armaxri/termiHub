---
id: FEC2-005
title: "Several Tauri listener setups still skip FEC-017's disposed-guard pattern and leak the listener when cleanup runs before listen() resolves"
angle: frontend-components
severity: low
category: lifecycle
is_workaround: false
subsystem: "src/components + src/hooks event subscriptions"
evidence:
  - src/hooks/useAgentUpdateEvents.ts:15-31
  - src/hooks/useAgentUpdatePendingEvents.ts:18-34
  - src/hooks/useEmbeddedServerEvents.ts:24-36
  - src/components/Terminal/TerminalView.tsx:97-120
  - src/components/Terminal/TerminalView.tsx:123-270
  - src/components/OpenConnections/XServerConnectConsent.tsx:57-76
  - src/components/OpenConnections/XServerConnectConsent.tsx:101-128
  - src/components/OpenConnections/xServerProvisioning.ts:27-45
status: fixed
resolution: "#4375 — shared useTauriListener/useTauriSubscription disposed-guard hooks adopted by every listed listener setup"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

These effects assign `unlisten` only after `await listen(...)` resolves, and their cleanup calls `unlisten?.()`. When cleanup runs first (StrictMode's mount, unmount, mount cycle, which `main.tsx:50` enables, or a fast phase change in XServerConnectConsent), the listener that registers afterwards is never removed. In the hooks and TerminalView there is no `cancelled` check, so the leaked handler stays live and every event is handled twice. That includes TerminalView's `agent-state-change` handler, which calls `wakeWaitingAgentTabs`, `restartAgentRetryTabs` and `settleSessionLost`. FEC-017 fixed only useTransferEvents. Other sites already use the correct pattern (SshHostKeyPrompt, AgentCrashReportNotice, NetworkToolsSidebar).

## Why it matters

Doubled agent-reconnect handling in development builds makes reconnect behavior differ from production right where reconnect is being verified. The XServer provisioning effect leaks one (cancel-guarded, inert) listener per quick phase change. Production impact is small because these components mount once per window. This is the same defect class as FEC-017 at sites the fix did not reach.

## Evidence

- `src/hooks/useAgentUpdateEvents.ts:15-31`
- `src/hooks/useAgentUpdatePendingEvents.ts:18-34`
- `src/hooks/useEmbeddedServerEvents.ts:24-36`
- `src/components/Terminal/TerminalView.tsx:97-120`
- `src/components/Terminal/TerminalView.tsx:123-270`
- `src/components/OpenConnections/XServerConnectConsent.tsx:57-76`
- `src/components/OpenConnections/XServerConnectConsent.tsx:101-128`
- `src/components/OpenConnections/xServerProvisioning.ts:27-45`

## Recommendation

Use the disposed-guard registration everywhere: `listen(...).then((un) => (disposed ? un() : (unlisten = un)))` with `disposed = true` in cleanup. Better, add a shared `useTauriListener(event, handler)` hook that does this and switch these sites to it.

## Verification

Confirmed. `useAgentUpdateEvents`, `useEmbeddedServerEvents` and the `remote-state-change`/`agent-state-change` effects in `TerminalView` assign `unlisten` only after the await or `.then`, with no disposed guard, and `main.tsx:50` wraps the app in `React.StrictMode`. A cleanup that runs before `listen()` resolves therefore leaks a live, unguarded handler, which in dev means duplicate handling. `XServerConnectConsent`/`xServerProvisioning` leak handlers too, but the `cancelled` check makes them inert. StrictMode double-mounting happens only in dev and these components mount once per window, so low.
