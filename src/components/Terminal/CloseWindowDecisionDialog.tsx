import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowRight,
  Ban,
  FileWarning,
  Network,
  Plug,
  Power,
  Terminal,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Button, Modal, Select, toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { getAllLeaves } from "@/utils/panelTree";
import { cancelQuit, quitWindowReady } from "@/services/api";
import { errorMessage } from "@/utils/errorMessage";
import { frontendError } from "@/utils/frontendLog";
import { windowDisplayName } from "@/types/window";
import type { WindowCloseDirtyEditor, WindowCloseSessionRow } from "@/types/window";
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
 *
 * A window holding an editor with unsaved changes always reaches it (UX2-003),
 * so the close is never silent. "Move tabs" carries dirty file editors with
 * their unsaved buffer (#4412). An editor that cannot carry its unsaved state
 * (the connection, tunnel, workspace and settings forms) blocks the move until
 * the user explicitly discards it here or opens it to save or discard. Without a
 * window to move to, unsaved editors are listed as discarded and the choices are
 * Cancel or "Discard & close".
 *
 * The same dialog answers an app quit (Cmd+Q / menu Quit, #4296) when the
 * request's `mode` is `"quit"`. Then "Quit" tells the backend this window
 * agrees (the backend exits the app once every window has), "Cancel" cancels
 * the whole quit, and moving tabs is not offered since every window is going.
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

  const isQuit = request.mode === "quit";

  const answerQuit = async (answer: () => Promise<void>) => {
    try {
      await answer();
    } catch (err) {
      frontendError("multi_window", `Answering the app quit failed: ${errorMessage(err)}`);
    }
  };

  const handleCancel = async () => {
    setRequest(null);
    if (isQuit) await answerQuit(cancelQuit);
  };

  const handleEnd = async () => {
    if (isQuit) {
      // The app exit ends the sessions; ending them here would leave this
      // window broken if another window cancels the quit.
      setRequest(null);
      await answerQuit(quitWindowReady);
      return;
    }
    await endWindowSessions();
    setRequest(null);
    await getCurrentWindow().destroy();
  };

  const count = request.sessions.length;
  const dirtyEditors = request.dirtyEditors ?? [];
  const dirtyCount = dirtyEditors.length;
  const movableCount = dirtyEditors.filter((editor) => editor.movable).length;
  const blockedEditors = dirtyEditors.filter((editor) => !editor.movable);
  // Move is offered when there is somewhere to go and something to carry; it
  // stays disabled while an editor would otherwise be discarded silently.
  const showMove = canMove && (count > 0 || movableCount > 0);
  const moveBlocked = blockedEditors.length > 0;

  const handleMove = async () => {
    if (!selected || moveBlocked) return;
    try {
      await moveWindowSessionsToWindow({ kind: "existing", label: selected });
    } catch (err) {
      // Nothing was handed off for good: keep the window and the dialog open so
      // the user can retry or choose another outcome.
      frontendError("multi_window", `Moving this window's tabs failed: ${errorMessage(err)}`);
      toast.error(`Could not move the tabs: ${errorMessage(err)}`);
      return;
    }
    setRequest(null);
    await getCurrentWindow().destroy();
  };

  /** Explicit Discard of one blocked editor: close its tab without saving. */
  const handleDiscardEditor = async (editor: WindowCloseDirtyEditor) => {
    const store = useAppStore.getState();
    const located = locateTab(editor.tabId);
    if (located) {
      store.setEditorDirty(editor.tabId, false);
      store.setActiveTabGroup(located.groupId);
      store.closeTab(editor.tabId, located.panelId);
    }
    const remaining = dirtyEditors.filter((e) => e.tabId !== editor.tabId);
    if (count === 0 && remaining.length === 0) {
      // Nothing is left that closing would lose, so close as asked.
      setRequest(null);
      await getCurrentWindow().destroy();
      return;
    }
    setRequest({ ...request, dirtyEditors: remaining });
  };

  /**
   * Leave the close and open the blocked editor with its own unsaved-changes
   * prompt, where the user saves or discards it explicitly.
   */
  const handleReviewEditor = (editor: WindowCloseDirtyEditor) => {
    setRequest(null);
    const located = locateTab(editor.tabId);
    if (!located) return;
    const store = useAppStore.getState();
    store.setActiveTabGroup(located.groupId);
    store.setActiveTab(editor.tabId, located.panelId);
    store.setPendingCloseRequest({ tabId: editor.tabId, panelId: located.panelId });
  };
  const moveLabel =
    others.length === 1 && selected ? `Move tabs to ${windowDisplayName(selected)}` : "Move tabs";

  return (
    <Modal
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) void handleCancel();
      }}
      title={isQuit ? "Quit termiHub?" : "Close this window?"}
      description={
        count > 0
          ? `Choose what happens to this window's live sessions before ${isQuit ? "termiHub quits" : "it closes"}.`
          : `This window has unsaved editors that ${isQuit ? "quitting" : "closing it"} would discard.`
      }
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
            {count > 0 ? (
              <>
                <Power className="li" aria-hidden="true" /> {isQuit ? "Quit" : "Close"} &amp; end
                sessions
              </>
            ) : (
              <>
                <Trash2 className="li" aria-hidden="true" /> Discard &amp;{" "}
                {isQuit ? "quit" : "close"}
              </>
            )}
          </Button>
          {showMove && (
            <Button
              variant="primary"
              onClick={handleMove}
              disabled={moveBlocked}
              data-testid="close-window-decision-move"
            >
              <ArrowRight className="li" aria-hidden="true" /> {moveLabel}
            </Button>
          )}
        </>
      }
    >
      <div className="close-window-decision__lead">
        <TriangleAlert className="li close-window-decision__lead-icon" aria-hidden="true" />
        <p>
          {count > 0 && (
            <>
              This window owns {count} open session{count === 1 ? "" : "s"}. Choose what happens to{" "}
              {count === 1 ? "it" : "them"} before {isQuit ? "termiHub quits" : "it closes"}.
            </>
          )}
          {count > 0 && dirtyCount > 0 && " "}
          {dirtyCount > 0 &&
            (showMove ? (
              <>
                {dirtyCount} unsaved editor{dirtyCount === 1 ? "" : "s"}: moving keeps{" "}
                {dirtyCount === 1 ? "it" : "them"}, closing discards{" "}
                {dirtyCount === 1 ? "it" : "them"}.
              </>
            ) : (
              <>
                {dirtyCount} unsaved editor{dirtyCount === 1 ? "" : "s"} will be discarded.
              </>
            ))}
        </p>
      </div>

      {showMove && moveBlocked && (
        <p
          className="close-window-decision__blocked"
          data-testid="close-window-decision-move-blocked"
        >
          {blockedEditors.map((editor) => `"${editor.title}"`).join(", ")} can&apos;t be moved with
          unsaved changes. Save or discard {blockedEditors.length === 1 ? "it" : "them"} to move the
          tabs.
        </p>
      )}

      {others.length > 1 && count > 0 && (
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
        {dirtyEditors.map((editor) => (
          <div
            key={editor.tabId}
            className="close-window-decision__row"
            data-testid="close-window-decision-dirty-row"
          >
            <FileWarning className="li close-window-decision__row-icon" aria-hidden="true" />
            <span className="close-window-decision__row-name">{editor.title}</span>
            <span className="close-window-decision__row-type">editor</span>
            {!showMove ? (
              <span
                className="close-window-decision__pill close-window-decision__pill--terminate"
                data-testid="close-window-decision-outcome-discard"
              >
                <Trash2 className="li" aria-hidden="true" /> Unsaved — discarded
              </span>
            ) : editor.movable ? (
              <span
                className="close-window-decision__pill close-window-decision__pill--detach"
                data-testid="close-window-decision-outcome-move"
              >
                <ArrowRight className="li" aria-hidden="true" /> Unsaved — moves with tabs
              </span>
            ) : (
              <>
                <span
                  className="close-window-decision__pill close-window-decision__pill--terminate"
                  data-testid="close-window-decision-outcome-blocked"
                >
                  <Ban className="li" aria-hidden="true" /> Can&apos;t be moved
                </span>
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => handleReviewEditor(editor)}
                  data-testid="close-window-decision-review-editor"
                >
                  Save or discard…
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  onClick={() => void handleDiscardEditor(editor)}
                  data-testid="close-window-decision-discard-editor"
                >
                  Discard
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** The tab group and panel currently holding `tabId` in this window, if any. */
function locateTab(tabId: string): { groupId: string; panelId: string } | null {
  for (const group of getLayoutTabGroups()) {
    for (const leaf of getAllLeaves(group.rootPanel)) {
      if (leaf.tabs.some((tab) => tab.id === tabId)) {
        return { groupId: group.id, panelId: leaf.id };
      }
    }
  }
  return null;
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
