---
id: DEAD2-006
title: "Production-dead frontend modules and exports go unreported because knip treats test files as entry points"
angle: deadcode-flags
severity: low
category: dead-code
is_workaround: false
subsystem: "src/utils, src/store, src/services, knip.jsonc"
evidence:
  - knip.jsonc:7
  - src/utils/keybindingHelpers.ts:4
  - src/utils/computeFlatVisibleIds.ts:16
  - src/utils/workspaceLayout.ts:240
  - src/utils/workspaceLayout.ts:282
  - src/store/layoutBridge.ts:331
  - src/services/events.ts:204
  - src/utils/backendErrorCode.ts:153
  - src/utils/reconnectBackoff.ts:126
  - src/utils/reconnectBackoff.ts:214
  - src/services/keybindings.ts:586
  - src/utils/typedConnectionConfig.ts:171
  - src/utils/jumpHost.ts:32
  - src/utils/tunnelChain.ts:107
  - src/services/commands.ts:46
  - .github/workflows/code-quality.yml:473
status: open
resolution: ""
audit: 2026-10
commit: 663465d52
relation: new
---

## What

knip.jsonc lists `src/**/*.test.{ts,tsx}` as entry points. So any export whose only importer is its own unit test counts as 'used', and the advisory knip step (code-quality.yml:473) never reports it, even after #3158's cleanup. Examples: all of keybindingHelpers.ts (isCopyShortcut / isPasteShortcut / isSelectAllShortcut; clipboard keys now go through the keybinding registry); all of computeFlatVisibleIds.ts (ConnectionList.tsx:761 and AgentNode.tsx:773 now derive the IDs from the flattened virtual tree); workspaceLayout.updateTabInLeaf / moveTabBetweenLeaves; layoutBridge.collectTabs; events.onTerminalExit; backendErrorCode.isAgentTimeout (added in 9ea363909, never consumed); reconnectBackoff.worstCaseTotalBackoffMs / isActiveReconnectPhase; keybindings.isActionUnbound; the isSerial/Telnet/DockerConnectionConfig guards; hasJumpHost; tunnelChain.findParent; PALETTE_EXCLUDED_ACTIONS. In total about 40 non-test-helper exports are referenced only by tests.

## Why it matters

Code kept alive only by its own tests looks covered and maintained while serving no user. It also hides the IPC-wrapper orphans in the finding above. The release goal of 'no dead paths, no scaffolding' cannot be checked while the tool cannot see this kind of dead code.

## Evidence

- `knip.jsonc:7`
- `src/utils/keybindingHelpers.ts:4`
- `src/utils/computeFlatVisibleIds.ts:16`
- `src/utils/workspaceLayout.ts:240`
- `src/utils/workspaceLayout.ts:282`
- `src/store/layoutBridge.ts:331`
- `src/services/events.ts:204`
- `src/utils/backendErrorCode.ts:153`
- `src/utils/reconnectBackoff.ts:126`
- `src/utils/reconnectBackoff.ts:214`
- `src/services/keybindings.ts:586`
- `src/utils/typedConnectionConfig.ts:171`
- `src/utils/jumpHost.ts:32`
- `src/utils/tunnelChain.ts:107`
- `src/services/commands.ts:46`
- `.github/workflows/code-quality.yml:473`

## Recommendation

Add a second advisory run, `knip --production` (it ignores test entries; mark test-only helpers with `!` or `@internal` as needed), so exports used only by tests are reported. Then delete the dead files and exports above together with their test cases. The Rust twins in core/src/reconnect_backoff.rs:208,454 (worst_case_total_backoff_ms / is_active_reconnect_phase) are test-only as well, so remove them at the same time to keep the golden-fixture parity.

## Verification

Confirmed. knip.jsonc lists src/\*_/_.test.{ts,tsx} as entry points. I spot-checked 11 of the named exports (isCopyShortcut, updateTabInLeaf, moveTabBetweenLeaves, collectTabs, onTerminalExit, isAgentTimeout, worstCaseTotalBackoffMs, isActiveReconnectPhase, isActionUnbound, hasJumpHost, PALETTE_EXCLUDED_ACTIONS). Each appears exactly once in its own file, at its definition, and has no other non-test reference in src/, so only tests keep it alive. computeFlatVisibleIds is likewise referenced only in its own file.
