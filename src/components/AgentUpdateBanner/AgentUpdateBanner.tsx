import { Fragment, useCallback, useState, type ReactNode } from "react";
import { ArrowUpCircle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { Button, ConfirmDialog, toast } from "@/components/ui";
import { requestAgentDeferredUpdate, requestAgentUpdate } from "@/services/api";
import { isExpectedApplyDisconnect } from "./expectedApplyDisconnect";
import "./AgentUpdateBanner.css";

/** Props for {@link AgentUpdateBanner}. */
export interface AgentUpdateBannerProps {
  /** Id of the agent this banner belongs to. */
  agentId: string;
  /** Display name of the agent, named in the strip's accessible label and the confirm. */
  agentName: string;
  /**
   * The sessions running on this agent, by the labels its "Active sessions"
   * list shows (#5821, #5953). When there are any, the strip and the apply
   * confirm name them: the agent does not cut them off, it waits for the last
   * one to close before it restarts.
   */
  sessionNames?: readonly string[];
}

/** Whether the agent has a staged update the user has not closed (#1352). */
function useVisibleUpdate(agentId: string) {
  const update = useAppStore((s) => s.agentUpdates[agentId]);
  const dismissed = useAppStore((s) => s.agentUpdatesDismissed[agentId] ?? false);
  return update && update.staged && !dismissed ? update : null;
}

const NO_SESSIONS: readonly string[] = [];

/** `1 session` / `2 sessions`. */
function sessionCount(n: number): string {
  return `${n} session${n === 1 ? "" : "s"}`;
}

/** `1 session (bash)` / `2 sessions (bash, bash 2)` (#5953). */
function namedSessions(names: readonly string[]): string {
  return `${sessionCount(names.length)} (${names.join(", ")})`;
}

/**
 * The strip's note naming the sessions the update waits for (#5953). Each name
 * stays on one line (#5980): "sys-pr-agent-24ef8dc4 · bash" used to break at
 * " · bash)", so the shell name sat alone on the next line.
 */
function waitingNote(names: readonly string[]): ReactNode {
  return (
    <>
      Waits for {sessionCount(names.length)}{" "}
      {names.map((name, i) => (
        <Fragment key={`${i}-${name}`}>
          {/* The parenthesis or comma stays with its name, never alone on a line. */}
          <span className="agent-update-banner__session-part">
            {i === 0 && "("}
            <span className="agent-update-banner__session" title={name}>
              {name}
            </span>
            {i === names.length - 1 ? ")" : ","}
          </span>{" "}
        </Fragment>
      ))}
      to close.
    </>
  );
}

/**
 * What "Restart agent and update" does to the open sessions (#5980): nothing.
 * The agent does not cut them off; it updates when the last one closes.
 */
export function keptSessionsLine(openSessions: number): string {
  return openSessions === 1
    ? "Your session keeps running."
    : `Your ${openSessions} sessions keep running.`;
}

/** Props for {@link AgentUpdateMarker}. */
export interface AgentUpdateMarkerProps {
  /** Id of the agent whose staged update the marker flags. */
  agentId: string;
}

/**
 * The compact "update available" marker on the agent's sidebar row (#5821).
 * The row carries only this icon; the words and the action live in the
 * full-width {@link AgentUpdateBanner} strip under the row.
 */
export function AgentUpdateMarker({ agentId }: AgentUpdateMarkerProps) {
  const update = useVisibleUpdate(agentId);
  if (!update) return null;
  const label = `Update to v${update.availableVersion} available`;
  return (
    <span
      className="agent-update-marker"
      role="img"
      aria-label={label}
      title={label}
      data-testid={`agent-update-marker-${agentId}`}
    >
      <ArrowUpCircle size={14} aria-hidden="true" />
    </span>
  );
}

/**
 * Per-agent strip offering to apply a staged deferred update (#1352). A
 * full-width strip under a connected agent's row (#5821: stacked, never three
 * columns squeezed into the narrow sidebar row), shown when the agent has reported a staged update
 * (`agent.update_available`, `staged: true`) that the user has not dismissed.
 *
 * "Apply now" requests the deferred update: when the agent is idle it swaps
 * immediately (`applied: true`); otherwise it defers until the last active
 * session disconnects (`applied: false`, `activeSessions: N`). The staged
 * binary is applied automatically on that last disconnect regardless — the
 * banner just lets the user trigger it sooner. "Later" hides the strip (#5980:
 * "Close" beside "Waits for 1 session to close." read as closing the session),
 * and the line under the apply button says the open sessions keep running.
 * Every outcome resolves with a
 * toast; a post-apply connection drop is treated as expected.
 */
export function AgentUpdateBanner({
  agentId,
  agentName,
  sessionNames = NO_SESSIONS,
}: AgentUpdateBannerProps) {
  const openSessions = sessionNames.length;
  const update = useVisibleUpdate(agentId);
  const [confirming, setConfirming] = useState(false);
  const dismissAgentUpdate = useAppStore((s) => s.dismissAgentUpdate);
  // A coordinated-strategy agent stages its self-update and waits for a
  // coordinated apply (#1351): "Apply now" must go through `agent.request_update`
  // so every *other* connected host is warned and given a clean reconnect
  // window, rather than updated without notice by the plain deferred apply
  // (#1602). Neither path cuts the other hosts off (#4037).
  const { remoteAgents } = useProjectedAgents();
  const isCoordinated =
    remoteAgents.find((a) => a.id === agentId)?.config.updateStrategy === "coordinated";

  const handleApply = useCallback(async () => {
    try {
      if (isCoordinated) {
        const result = await requestAgentUpdate(agentId);
        if (result.applied) {
          const n = result.notifiedClients;
          // toast-policy: background — the agent updates and reconnects on its own
          toast.success(
            n > 0
              ? `Agent updating — ${n} other host${n === 1 ? "" : "s"} notified. Reconnecting…`
              : "Agent updated — reconnecting…"
          );
        } else {
          const n = result.activeSessions;
          // toast-policy: background — the update waits for the agent's sessions to end
          toast.info(
            `Update deferred — it will be applied automatically when the last of ${n} active ` +
              `session${n === 1 ? "" : "s"} disconnects.`
          );
        }
        dismissAgentUpdate(agentId);
        return;
      }
      const result = await requestAgentDeferredUpdate(agentId);
      if (result.applied) {
        // toast-policy: background — the agent updates and reconnects on its own
        toast.success("Agent updated — reconnecting…");
      } else {
        const n = result.activeSessions;
        // toast-policy: background — the update waits for the agent's sessions to end
        toast.info(
          `Update deferred — it will be applied automatically when the last of ${n} active ` +
            `session${n === 1 ? "" : "s"} disconnects.`
        );
      }
      dismissAgentUpdate(agentId);
    } catch (err) {
      // An immediate apply re-execs the agent, tearing down its transport — so a
      // failure here is expected *only if it was that transport closing*. Decide
      // from the structured error code (`agent_transport_closed`, #2840; an
      // agent-reported `remote_error` fails at once, #3959), falling back to the
      // agent's authoritative connection state (a drop within a short window) for
      // a timeout or uncoded error — never by parsing the error message, which
      // was locale-fragile and over-broad (I18N-008). If neither shows the
      // transport closed, this was a real update failure — surface it.
      if (await isExpectedApplyDisconnect(agentId, err)) {
        // toast-policy: background — the agent updates and reconnects on its own
        toast.info("Agent is updating — it will reconnect automatically once the swap completes.");
        dismissAgentUpdate(agentId);
        return;
      }
      // Genuine failure: rethrow so the async Button surfaces a recoverable
      // error toast and returns to idle.
      throw err;
    }
  }, [agentId, dismissAgentUpdate, isCoordinated]);

  const handleDismiss = useCallback(() => {
    dismissAgentUpdate(agentId);
  }, [agentId, dismissAgentUpdate]);

  // With sessions open the apply waits for them, so say that first (R-012).
  const handleApplyClick = useCallback(async () => {
    if (openSessions > 0) {
      setConfirming(true);
      return;
    }
    await handleApply();
  }, [handleApply, openSessions]);

  const handleConfirm = useCallback(async () => {
    await handleApply();
    setConfirming(false);
  }, [handleApply]);

  // Only surface a staged, undismissed update.
  if (!update) {
    return null;
  }

  return (
    <div
      className="agent-update-banner"
      role="region"
      aria-label={`Update for "${agentName}"`}
      data-testid={`agent-update-banner-${agentId}`}
    >
      <div className="agent-update-banner__head">
        <ArrowUpCircle size={14} className="agent-update-banner__icon" aria-hidden="true" />
        <strong
          className="agent-update-banner__title"
          data-testid={`agent-update-banner-title-${agentId}`}
        >
          Update to v{update.availableVersion} available
        </strong>
      </div>
      <span
        className="agent-update-banner__note"
        data-testid={`agent-update-banner-note-${agentId}`}
      >
        {openSessions > 0 ? waitingNote(sessionNames) : "The agent restarts and reconnects."}
      </span>
      <div className="agent-update-banner__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          data-testid={`agent-update-banner-dismiss-${agentId}`}
        >
          Later
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleApplyClick}
          data-testid={`agent-update-banner-apply-${agentId}`}
        >
          Restart agent and update
        </Button>
      </div>
      {openSessions > 0 && (
        <span
          className="agent-update-banner__consequence"
          data-testid={`agent-update-banner-consequence-${agentId}`}
        >
          {keptSessionsLine(openSessions)}
        </span>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Update "${agentName}"?`}
        message={
          `${namedSessions(sessionNames)} ${openSessions === 1 ? "is" : "are"} open on this ` +
          "agent. They are not interrupted: the agent restarts and updates when the last " +
          "one closes."
        }
        confirmLabel="Update when they close"
        confirmVariant="primary"
        onConfirm={handleConfirm}
        onCancel={() => setConfirming(false)}
        testIdBase={`agent-update-confirm-${agentId}`}
        data-testid={`agent-update-confirm-${agentId}`}
      />
    </div>
  );
}
