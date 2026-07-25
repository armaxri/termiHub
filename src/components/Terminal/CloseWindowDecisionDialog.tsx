import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowRight, Network, Plug, Power, Terminal, TriangleAlert } from "lucide-react";
import { Button, Modal, Select } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { windowDisplayName } from "@/types/window";
import type { WindowCloseSessionRow } from "@/types/window";
import "./CloseWindowDecisionDialog.css";

/**
 * The close-with-live-tabs decision surface (#1903, epic #1899).
 *
 * When the OS requests a window's close and that window still owns a
 * non-persistent live session, {@link AppState.prepareWindowClose} raises this
 * dialog instead of silently killing sessions. It lists each owned session with
 * its outcome — persistent/agent sessions **detach** (keep running),
 * non-persistent ones **would be terminated** — and offers three choices:
 *
 * - **Move tabs to another window** (safe primary) — re-parents every owned live
 *   tab so nothing is lost, then closes the now-empty window. Shown only when
 *   another window exists.
 * - **Close & end sessions** (destructive, red) — detaches persistent sessions,
 *   terminates non-persistent ones, then closes.
 * - **Cancel** — keep the window open.
 *
 * All-persistent and empty windows never reach this dialog; they close with a
 * toast (or silently) from {@link AppState.prepareWindowClose}.
 */
export function CloseWindowDecisionDialog() {
  const request = useAppStore((s) => s.pendingWindowClose);
  const setRequest = useAppStore((s) => s.setPendingWindowClose);
  const endWindowSessions = useAppStore((s) => s.endWindowSessions);
  const moveWindowSessionsToWindow = useAppStore((s) => s.moveWindowSessionsToWindow);
  const [targetLabel, setTargetLabel] = useState<string | undefined>(undefined);

  if (!request) return null;

  const others = request.otherWindows;
  const selected = targetLabel ?? others[0]?.label;
  const canMove = others.length > 0 && Boolean(selected);

  const handleCancel = () => setRequest(null);

  const handleEnd = async () => {
    await endWindowSessions();
    setRequest(null);
    await getCurrentWindow().destroy();
  };

  const handleMove = async () => {
    if (!selected) return;
    await moveWindowSessionsToWindow({ kind: "existing", label: selected });
    setRequest(null);
    await getCurrentWindow().destroy();
  };

  const count = request.sessions.length;
  const moveLabel =
    others.length === 1 && selected ? `Move tabs to ${windowDisplayName(selected)}` : "Move tabs";

  return (
    <Modal
      open
      onOpenChange={(isOpen) => !isOpen && handleCancel()}
      title="Close this window?"
      description="Choose what happens to this window's live sessions before it closes."
      data-testid="close-window-decision-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={handleCancel}
            data-testid="close-window-decision-cancel"
          >
            Cancel
          </Button>
          <Button variant="danger" onClick={handleEnd} data-testid="close-window-decision-end">
            <Power className="li" aria-hidden="true" /> Close &amp; end sessions
          </Button>
          {canMove && (
            <Button variant="primary" onClick={handleMove} data-testid="close-window-decision-move">
              <ArrowRight className="li" aria-hidden="true" /> {moveLabel}
            </Button>
          )}
        </>
      }
    >
      <div className="close-window-decision__lead">
        <TriangleAlert className="li close-window-decision__lead-icon" aria-hidden="true" />
        <p>
          This window owns {count} open session{count === 1 ? "" : "s"}. Choose what happens to{" "}
          {count === 1 ? "it" : "them"} before it closes.
        </p>
      </div>

      {others.length > 1 && (
        <div className="close-window-decision__target">
          <span className="close-window-decision__target-label">Move to</span>
          <Select
            value={selected}
            onChange={setTargetLabel}
            options={others.map((w) => ({ value: w.label, label: windowDisplayName(w.label) }))}
            aria-label="Destination window"
            data-testid="close-window-decision-target"
          />
        </div>
      )}

      <div className="close-window-decision__rows">
        {request.sessions.map((session) => (
          <SessionRow key={session.tabId} session={session} />
        ))}
      </div>
    </Modal>
  );
}

/** One per-session row: icon, name, connection type, and the outcome pill. */
function SessionRow({ session }: { session: WindowCloseSessionRow }) {
  const Icon = session.connectionType === "ssh" ? Network : Terminal;
  return (
    <div className="close-window-decision__row" data-testid="close-window-decision-row">
      <Icon className="li close-window-decision__row-icon" aria-hidden="true" />
      <span className="close-window-decision__row-name">{session.title}</span>
      <span className="close-window-decision__row-type">{session.connectionType}</span>
      {session.outcome === "detach" ? (
        <span
          className="close-window-decision__pill close-window-decision__pill--detach"
          data-testid="close-window-decision-outcome-detach"
        >
          <Plug className="li" aria-hidden="true" /> Detaches — keeps running
        </span>
      ) : (
        <span
          className="close-window-decision__pill close-window-decision__pill--terminate"
          data-testid="close-window-decision-outcome-terminate"
        >
          <Power className="li" aria-hidden="true" /> Would be terminated
        </span>
      )}
    </div>
  );
}
