---
id: WA-FE-011
title: react-hooks/exhaustive-deps suppressed at ~9 production sites
angle: workaround-frontend
severity: low
category: workaround
is_workaround: true
subsystem: components / hooks (multiple)
evidence:
  - src/App.tsx:270
  - src/components/Terminal/Terminal.tsx:1078
  - src/components/OpenConnections/OpenConnectionsModal.tsx:236
  - src/components/DynamicForm/ConnectionSettingsForm.tsx:161
  - src/components/CommandPalette/CommandPalette.tsx:120
  - src/components/NetworkTools/LatencyChart.tsx:157
status: open
---

## What
Nine production `useEffect`/`useCallback` sites suppress the `react-hooks/exhaustive-deps` lint
rather than declaring their real dependencies:

- `App.tsx:270`, `Terminal.tsx:1078`, `Sidebar/AgentSetupDialog.tsx:155`,
  `Sidebar/ConnectionPathDialog.tsx:128`, `OpenConnections/XServerSetupDialog.tsx:74`,
  `OpenConnections/OpenConnectionsModal.tsx:236` & `:242`, `NetworkTools/LatencyChart.tsx:157`,
  `CommandPalette/CommandPalette.tsx:120`, `DynamicForm/ConnectionSettingsForm.tsx:161` & `:196`.

Some also use hand-built dependency keys like `[connectedAgents.map((a) => a.id).join(",")]`
(OpenConnectionsModal.tsx:236) to work around the linter rather than depending on the value.

## Why it matters
- `exhaustive-deps` is the rule that catches stale-closure bugs (an effect capturing an old prop/
  state value and never re-running). Each suppression is an assertion "this is intentionally
  mount-once / the missing deps are stable" that is easy to get wrong and invisible thereafter.
- Most here are legitimately mount-once effects (e.g. `App.tsx:270` schedule-once update check),
  but the blanket suppressions make the genuinely-risky ones (effects that reference changing
  callbacks/state) indistinguishable from the safe ones.

## Evidence
`grep 'exhaustive-deps' src/**` — the 9 production sites listed (the remaining hits are test files).

## Recommendation
For each site, either declare the real deps, or if genuinely run-once, extract the values into
refs / a stable callback and delete the suppression. The `.join(",")` dep-key hacks should become
a `useMemo`'d stable identity. Reducing the production suppression count toward zero (keeping only
truly-mount-once effects, each with a one-line justification) is the signal.
