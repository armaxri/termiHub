import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FolderOpen, AlertCircle, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import { Button, ContentOverlay, toast } from "@/components/ui";
import { ConnectProgress } from "@/components/ui/ConnectProgress";
import {
  buildStages,
  connectOverlayIdentity,
  connectTypeLabel,
  stepsFor,
} from "@/utils/connectStages";
import { createTerminal, closeTerminal } from "@/services/api";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import "./FileBrowserTab.css";

interface FileBrowserTabProps {
  tabId: string;
  isVisible: boolean;
}

type Phase = "connecting" | "connected" | "error";

/**
 * Tab body for a terminal-less connection (`Capabilities.terminal === false`,
 * e.g. FTP). Instead of mounting an xterm terminal, it mints and owns the
 * connection's session directly — its own session-creation entry that does not
 * go through the `<Terminal>` component — so the sidebar file browser can route
 * to `tab.sessionId`. The body shows an informational placeholder; the actual
 * browsing happens in the sidebar file browser (#1335).
 *
 * Session lifecycle mirrors `Terminal.tsx`: a session already present on the tab
 * (e.g. pre-minted during credential validation) is adopted rather than
 * re-created, and the owned session is closed on unmount with a short deferral
 * so React StrictMode's mount→unmount→mount does not tear down a live session.
 */
export function FileBrowserTab({ tabId, isVisible }: FileBrowserTabProps) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  // Bumped by the retry button to re-run the connect effect.
  const [retryNonce, setRetryNonce] = useState(0);

  const sessionIdRef = useRef<string | null>(null);
  const pendingCloseRef = useRef<number | null>(null);

  const setTabSessionId = useAppStore((s) => s.setTabSessionId);
  // Title is reactive so a rename shows through; the config is read once in the
  // effect since it is stable for the tab's lifetime.
  const title = useAppStore((s) => activeTreeTabs(s).find((t) => t.id === tabId)?.title ?? "");
  const config = useAppStore((s) => activeTreeTabs(s).find((t) => t.id === tabId)?.config);
  const identity = connectOverlayIdentity(config ?? { type: "" });
  // The connect ring's elapsed readout counts from the attempt's start.
  const [startedAt, setStartedAt] = useState(() => Date.now());

  useEffect(() => {
    let canceled = false;

    // A pending close from a StrictMode unmount would destroy the session we are
    // about to reuse — cancel it so the remount adopts the same session.
    if (pendingCloseRef.current !== null) {
      clearTimeout(pendingCloseRef.current);
      pendingCloseRef.current = null;
    }

    const connect = async () => {
      const tab = activeTreeTabs(useAppStore.getState()).find((t) => t.id === tabId);
      if (!tab) return;

      // Adopt a session already attached to the tab (e.g. pre-minted while
      // validating a stored credential in useConnectSavedConnection).
      if (tab.sessionId) {
        sessionIdRef.current = tab.sessionId;
        setPhase("connected");
        return;
      }

      setPhase("connecting");
      setStartedAt(Date.now());
      setError(null);
      try {
        // Name the saved connection (#3876) so a transfer on this session can
        // be resumed after the session is gone.
        const sessionId = await createTerminal(
          tab.config,
          undefined,
          undefined,
          undefined,
          undefined,
          tab.connectionId
        );
        if (canceled) {
          // Superseded by a StrictMode remount — tear down the orphan session.
          fireAndForget(
            closeTerminal(sessionId),
            `close orphaned file-browser session ${sessionId}`
          );
          return;
        }
        sessionIdRef.current = sessionId;
        setTabSessionId(tabId, sessionId);
        setPhase("connected");
        frontendLog("file_browser_tab", `session ${sessionId} opened for tab ${tabId}`);
        toast.success("Connected", { description: tab.title });
      } catch (err) {
        if (canceled) return;
        // The backend rejects with a structured `{ code, message }` envelope,
        // not an Error — String() rendered it as "[object Object]" (#4017).
        setError(errorMessage(err));
        setPhase("error");
      }
    };

    void connect();

    return () => {
      canceled = true;
      const sid = sessionIdRef.current;
      if (sid) {
        // Defer the close so a StrictMode remount can cancel it (above) before
        // the backend session is destroyed. On a real tab close the timer fires.
        sessionIdRef.current = null;
        pendingCloseRef.current = window.setTimeout(() => {
          pendingCloseRef.current = null;
          fireAndForget(closeTerminal(sid), `close file-browser session ${sid} on tab close`);
          setTabSessionId(tabId, null);
        }, 50);
      }
    };
  }, [tabId, setTabSessionId, retryNonce]);

  // The error text is part of the failure overlay's accessible description.
  const errorTextId = useId();

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return (
    <div
      className={`file-browser-tab${isVisible ? "" : " file-browser-tab--hidden"}`}
      data-testid="file-browser-tab"
    >
      {phase === "connecting" && (
        // The shared connect surface (#5068); file-only types report no stages.
        <ConnectProgress
          phase="connecting"
          heading="Connecting…"
          target={identity.target || title || "the connection"}
          typeLabel={connectTypeLabel(identity.sessionType)}
          typeIcon={<FolderOpen size={20} aria-hidden />}
          details={identity.details}
          stages={buildStages(stepsFor(identity.sessionType), undefined)}
          status={`Opening ${title || "the connection"}.`}
          announcement={`Connecting… Opening ${title || "the connection"}.`}
          startedAt={startedAt}
          data-testid="file-browser-tab-connecting"
        />
      )}

      {phase === "connected" && (
        <ContentOverlay
          icon={<FolderOpen size={32} className="file-browser-tab__icon" aria-hidden />}
          heading="No terminal for this connection"
          subheading={
            <>
              {title ? `${title} browses files instead of running a shell. ` : ""}
              This connection has no terminal output. Use the file browser in the sidebar to
              navigate, open, and transfer files.
            </>
          }
          data-testid="file-browser-tab-connected"
        />
      )}

      {phase === "error" && (
        <ContentOverlay
          icon={
            <AlertCircle
              size={32}
              className="file-browser-tab__icon file-browser-tab__icon--error"
              aria-hidden
            />
          }
          heading="Could not open connection"
          announce="assertive"
          announcement={error ? "Could not open connection. ".concat(error) : undefined}
          describedBy={error ? errorTextId : undefined}
          autoFocusPrimaryAction={isVisible}
          data-testid="file-browser-tab-error"
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={handleRetry}
              data-testid="file-browser-tab-retry"
            >
              Retry
            </Button>
          }
        >
          {error && (
            <p id={errorTextId} className="file-browser-tab__error">
              {error}
            </p>
          )}
        </ContentOverlay>
      )}
    </div>
  );
}
