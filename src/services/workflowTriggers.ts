/**
 * Workflow trigger dispatch (#1855) — the runtime that *fires* the triggers
 * authored on a {@link Workflow} (the trigger data model and editing UI ship in
 * #1852 / #1854). This module owns the pure matching logic and the once-per
 * session-open guard for on-connect; the actual run is delegated back to the
 * store's `runWorkflow` so single-run-at-a-time enforcement is not duplicated.
 *
 * Three trigger kinds dispatch through here:
 * - `manual` — surfaced as command-palette entries and the sidebar run action
 *   (no matching needed; those call `runWorkflow` directly).
 * - `hotkey` — {@link matchHotkeyWorkflow} maps a keyboard event to a workflow,
 *   reusing the shared keybinding parser so workflow hotkeys and app shortcuts
 *   speak the same combo language.
 * - `on-connect` — {@link dispatchOnConnectTriggers} runs every workflow bound
 *   to a connection when a session for it finishes opening.
 */
import type { Workflow } from "@/types/workflow";
import type { KeyCombo } from "@/types/keybindings";
import { parseBinding, eventMatchesCombo, isUnboundCombo } from "@/services/keybindings";

/**
 * Find the first workflow whose `hotkey` trigger binding matches `event`.
 *
 * Bindings are parsed through the shared {@link parseBinding} so a workflow
 * hotkey resolves identically to an app shortcut. Empty or explicitly unbound
 * bindings are skipped — a workflow whose hotkey was cleared must not fire — and
 * only single-combo bindings are considered (chords remain an app-shortcut
 * concept). Returns the matching workflow id, or `null` when none match.
 */
export function matchHotkeyWorkflow(event: KeyboardEvent, workflows: Workflow[]): string | null {
  for (const workflow of workflows) {
    for (const trigger of workflow.triggers) {
      if (trigger.kind !== "hotkey") continue;
      const binding = trigger.binding?.trim();
      if (!binding) continue;

      const parsed = parseBinding(binding);
      if (isUnboundCombo(parsed)) continue;

      const combo: KeyCombo | undefined = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!combo || combo.key === "") continue;

      if (eventMatchesCombo(event, combo)) return workflow.id;
    }
  }
  return null;
}

/** Every workflow with an `on-connect` trigger bound to `connectionId`. */
export function matchOnConnectWorkflows(connectionId: string, workflows: Workflow[]): Workflow[] {
  return workflows.filter((workflow) =>
    workflow.triggers.some(
      (trigger) => trigger.kind === "on-connect" && trigger.connectionIds.includes(connectionId)
    )
  );
}

/**
 * Session opens already dispatched, keyed by backend session id. Enforces the
 * "at most once per session open" guard so a session-open signal delivered more
 * than once (React strict-mode double-invoke, a re-registration) does not run
 * the on-connect workflows twice.
 */
const dispatchedSessions = new Set<string>();

/** Arguments for {@link dispatchOnConnectTriggers}. */
export interface OnConnectDispatch {
  /** Saved-connection id the freshly opened session belongs to. */
  connectionId: string;
  /** The tab the workflow should run against. */
  tabId: string;
  /** Backend session id — the once-per-session-open guard key. */
  sessionId: string;
  /** Current set of saved workflows to match against. */
  workflows: Workflow[];
  /** Run a matched workflow against the freshly opened tab. */
  run: (workflowId: string, tabId: string) => void;
}

/**
 * Run every workflow whose `on-connect` trigger names `connectionId`, against
 * the freshly opened `tabId`. Guarded by `sessionId` so a given session open
 * fires at most once. The interactive-shell-only guard is applied by the caller
 * (the session-open path only invokes this for terminal tabs).
 */
export function dispatchOnConnectTriggers({
  connectionId,
  tabId,
  sessionId,
  workflows,
  run,
}: OnConnectDispatch): void {
  if (dispatchedSessions.has(sessionId)) return;

  const matches = matchOnConnectWorkflows(connectionId, workflows);
  if (matches.length === 0) return;

  dispatchedSessions.add(sessionId);
  for (const workflow of matches) {
    run(workflow.id, tabId);
  }
}

/** Forget a session's dispatch record (e.g. when its tab disconnects/closes). */
export function forgetOnConnectSession(sessionId: string): void {
  dispatchedSessions.delete(sessionId);
}

/** Clear all on-connect dispatch state. Intended for tests. */
export function resetOnConnectDispatchState(): void {
  dispatchedSessions.clear();
}
