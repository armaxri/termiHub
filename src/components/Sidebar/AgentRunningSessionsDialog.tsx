import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, ConfirmDialog, EmptyState, Modal } from "@/components/ui";
import { formatRelativeTime } from "@/utils/formatters";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import {
  listAgentHostSessions,
  takeOverAgentSession,
  type AgentHostSessionInfo,
  type AgentHostSessionsResult,
} from "@/services/api";
import "./AgentRunningSessionsDialog.css";

/** Props for {@link AgentRunningSessionsDialog}. */
export interface AgentRunningSessionsDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (close, ESC, or after opening a session). */
  onOpenChange: (open: boolean) => void;
  /** Agent whose host sessions are listed. */
  agentId: string;
  /** Agent display name, shown in the title. */
  agentName: string;
  /**
   * Open a tab bound to the session. Called for "Open" directly and for "Take
   * over" only after the confirmed takeover succeeded.
   */
  onOpenSession: (session: AgentHostSessionInfo) => void;
}

/** Reason shown when the agent predates `connection.list_host_sessions`. */
export const RUNNING_SESSIONS_UNSUPPORTED_REASON =
  "This agent is too old to list running sessions. Update the agent to open or take over sessions from here.";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; result: AgentHostSessionsResult };

function holderLabel(holder: AgentHostSessionInfo["holder"]): string {
  switch (holder) {
    case "self":
      return "Open on this desktop";
    case "other":
      return "Held by another desktop";
    default:
      return "Unattached";
  }
}

/**
 * Running Sessions (#3369): every session running on an agent's host,
 * including orphans nobody holds (left running unattached after an agent
 * restart) and sessions another desktop holds. "Open" binds a tab to an
 * unattached session; "Take over" — after a confirm, since it evicts the other
 * desktop — takes control and then opens it. Nobody owns an orphan until a user
 * picks it here.
 */
export function AgentRunningSessionsDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  onOpenSession,
}: AgentRunningSessionsDialogProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirmTakeOver, setConfirmTakeOver] = useState<AgentHostSessionInfo | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await listAgentHostSessions(agentId);
      setState({ kind: "loaded", result });
    } catch (err) {
      frontendLog("running_sessions", `list failed for ${agentId}: ${errorMessage(err)}`);
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [agentId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const openSession = (session: AgentHostSessionInfo) => {
    onOpenSession(session);
    onOpenChange(false);
  };

  const handleConfirmTakeOver = async (): Promise<void> => {
    const session = confirmTakeOver;
    if (!session) return;
    frontendLog("running_sessions", `take over ${agentId}/${session.sessionId}`);
    await takeOverAgentSession(agentId, session.sessionId);
    setConfirmTakeOver(null);
    openSession(session);
  };

  let body: React.ReactNode;
  if (state.kind === "loading") {
    body = <EmptyState loading title="Loading running sessions…" />;
  } else if (state.kind === "error") {
    body = (
      <EmptyState
        title="Could not list running sessions"
        description={state.message}
        data-testid="running-sessions-error"
      />
    );
  } else if (!state.result.supported) {
    body = (
      <EmptyState
        title="Not supported by this agent"
        description={RUNNING_SESSIONS_UNSUPPORTED_REASON}
        data-testid="running-sessions-unsupported"
      />
    );
  } else if (state.result.sessions.length === 0) {
    body = (
      <EmptyState
        title="No sessions are running on this agent"
        data-testid="running-sessions-empty"
      />
    );
  } else {
    body = (
      <ul className="running-sessions__list" data-testid="running-sessions-list">
        {state.result.sessions.map((session) => (
          <li
            key={session.sessionId}
            className="running-sessions__row"
            data-testid={`running-session-${session.sessionId}`}
          >
            <div className="running-sessions__info">
              <span className="running-sessions__title">
                {session.title || `Session ${session.sessionId.slice(0, 8)}`}
              </span>
              <span className="running-sessions__meta">
                {session.type} · started {formatRelativeTime(session.createdAt)}
              </span>
            </div>
            <span
              className={`running-sessions__holder running-sessions__holder--${session.holder}`}
              data-testid={`running-session-holder-${session.sessionId}`}
            >
              {holderLabel(session.holder)}
            </span>
            {session.holder === "other" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmTakeOver(session)}
                data-testid={`running-session-takeover-${session.sessionId}`}
              >
                Take over
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openSession(session)}
                data-testid={`running-session-open-${session.sessionId}`}
              >
                Open
              </Button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`Running sessions on ${agentName}`}
        description={`Sessions running on ${agentName}`}
        size="lg"
        data-testid="running-sessions-dialog"
        footer={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void load()}
            data-testid="running-sessions-refresh"
          >
            Refresh
          </Button>
        }
      >
        {body}
      </Modal>
      <ConfirmDialog
        open={confirmTakeOver !== null}
        title="Take over this session?"
        variant="warn"
        message={
          "Another desktop is using this session. Taking it over moves control to this " +
          'desktop; the other desktop will see "Taken over by another desktop" and can ' +
          "reclaim it."
        }
        confirmLabel="Take over"
        confirmVariant="primary"
        testIdBase="running-session-takeover-confirm"
        data-testid="running-session-takeover-confirm-dialog"
        onConfirm={handleConfirmTakeOver}
        onCancel={() => setConfirmTakeOver(null)}
      />
    </>
  );
}
