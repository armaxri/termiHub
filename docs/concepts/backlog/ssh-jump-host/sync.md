# Sync Ledger — SSH Jump Host

**Last synced:** 2026-06-30 at commit `be96039d`
**Status:** in-sync (editor UI reconciled; remaining items are deferred phases, not divergences)

This ledger is maintained by the `/sync-concept ssh-jump-host` skill. It records the last
commit at which the concept artifacts and the code were reconciled, plus any open divergences.

## Open divergences

| #   | Artifact claim                                                                                                            | Code reality                                                                                                                                    | Type    | Recommendation                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| 1   | "Jump host unreachable / target unreachable / per-hop auth failed" connect-time error UX (concept §Edge Cases)            | Backend resolves and connects the chain; the granular per-hop connect-time error toasts in the concept are not yet surfaced verbatim in the UI. | Missing | Leave open — connect-time error UX polish is a later refinement (#933). |
| 2   | Reconnection banner "Connection lost (jump host disconnected). [Reconnect]" per terminal (concept §Reconnection Behavior) | Gateway-drop handling exists at the pool level; the dedicated per-terminal jump-host reconnection banner copy is not yet a distinct surface.    | Missing | Leave open — reconnection-UX is a later phase, tracked separately.      |

Neither open item is a contradiction between the concept and shipped code — they are
not-yet-built refinements of the same design. The editor UI (the subject of #937) is now
reconciled.

## Resolved

| Date       | #   | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-30 | R1  | **Collapsible group → flat editor category.** Concept (and editor mockup states 1–4) showed a _collapsible_ "Jump Host" group with a chevron, between "Authentication" and an "Advanced" group. The connection editor has no collapsible groups or "Advanced" group — it renders flat `settings-panel__category` blocks. **Concept + mockup updated to match the flat category** (titled "Jump Host", after the connection/auth fields, before the SSH Agent category). Edited `concept.md` and `mockups/ssh-jump-host-editor.html`.                        |
| 2026-06-30 | R2  | **Data model: no `source` / `jumpHostEnabled` fields.** Concept Impl Details proposed a `JumpHostEntry.source: "saved" \| "inline"` discriminator and an `SshConnectionConfig.jumpHostEnabled: boolean` flag. The shipped model has neither: a hop is "saved" iff it carries `connectionId` (otherwise inline), and the section is "enabled" iff the `proxyJump` array is non-empty. The cleaner derived model is what shipped; **concept Impl Details updated** to describe `JumpHostConfig` (no `source`, no `jumpHostEnabled`) and the derivation rules. |
| 2026-06-30 | R3  | **Per-hop connect timeout (#951) was undocumented.** Each hop has an optional `connectTimeoutSecs` field (per-hop connect/handshake timeout, falling back to the default). **Documented** in `concept.md` and added to the inline-mode editor mockup.                                                                                                                                                                                                                                                                                                       |
| 2026-06-30 | R4  | **Path separator icon.** Concept editor mockup joined connection-path nodes with the `ArrowLeftRight` icon; the shipped `JumpHostPathDisplay` uses a directional `ArrowRight`. **Mockup updated** to `ArrowRight` for the path line (the sidebar/badge keeps `ArrowLeftRight`, which matches the code).                                                                                                                                                                                                                                                     |
| 2026-06-30 | R5  | **Path-line label.** Concept used `Connection path:` (trailing colon) with monospace node text; code renders a `Connection path` label with the chain. Treated as cosmetic; mockup label aligned to `Connection path` (no behavioral change).                                                                                                                                                                                                                                                                                                               |
| 2026-06-30 | —   | Indicators mockup (sidebar hop badge + hop-count + tooltip, status-bar `Route` hop chain, context-menu "Open Jump Host Terminal" / "Show Connection Path", connection-path dialog) — **verified matching** the shipped `ConnectionList.tsx`, `ConnectionPathDialog.tsx`, `StatusBar.tsx`, and `src/utils/jumpHost.ts`. No change needed.                                                                                                                                                                                                                    |

## Notes

- 2026-06-30 (#937): Editor-UI reconciliation pass. The "Jump Host" connection-editor section
  shipped across #922/#923/#925 (+ #940 saved-connection mode, #941 deletion protection, #951
  per-hop timeout). It is a **flat `settings-panel__category`** with an enable checkbox, a
  per-hop **source segmented control** (Saved connection / Inline configuration), a saved-SSH
  dropdown (folder-path labelled), inline SSH fields, a per-hop connect-timeout field, an
  "Add another hop" control rendering numbered removable hop cards for multi-hop chains, a
  `Connection path` summary line, non-blocking warnings, and blocking validation errors that
  disable Save. Components: `JumpHostSection.tsx`, `JumpHostEntry.tsx`, `JumpHostPathDisplay.tsx`;
  helpers `src/utils/jumpHost.ts`, `src/utils/validateProxyJump.ts`; wiring in
  `ConnectionEditor.tsx`. The concept and editor mockup were updated to reflect the flat-category
  layout and the derived data model; see Resolved R1–R5.
- 2026-06-30 (#924): **Phase 3 — session pooling** implemented. The reference-counted SSH session
  pool moved into the core crate as a generic `RefPool<T>` (`core/src/backends/ssh/session_pool.rs`)
  with single-flight creation; `SshGateway` + the process-wide `shared_gateway_pool()` pool jump-host
  gateway sessions keyed by the resolved hop chain (`gateway_pool_key`), tracking outer hops in
  `SshGateway.intermediate_sessions`. The terminal connect path (`connector.rs`) and the desktop
  tunnel manager both acquire gateways from this one pool, so connections sharing a bastion reuse one
  gateway session; SSH tunnels with a `proxyJump` chain now connect through (and pool) the gateway.
  Covered by pool unit tests, `gateway_pool_key` unit tests, and the `SSH-JUMP-03` Docker integration
  test.
- 2026-06-29 (#872): Concept refined to match the real SSH stack — termiHub uses **russh 0.61**
  (async), not `ssh2`/libssh2. Backend impl details rewritten around `channel_open_direct_tcpip` +
  `channel.into_stream()` + `russh::client::connect_stream` (already used by the tunnel forwarders
  and SFTP/X11), the config field renamed to `proxy_jump` (OpenSSH `-J` style), and a concrete
  `SSH-JUMP-01` test-conversion plan added against the existing `ssh-jumphost-bastion` /
  `ssh-jumphost-target` Docker fixtures.
  </content>
  </invoke>
