import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import { Button } from "@/components/ui";
import { createTerminal, closeTerminal } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
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
      setError(null);
      try {
        const sessionId = await createTerminal(tab.config);
        if (canceled) {
          // Superseded by a StrictMode remount — tear down the orphan session.
          closeTerminal(sessionId).catch(() => {});
          return;
        }
        sessionIdRef.current = sessionId;
        setTabSessionId(tabId, sessionId);
        setPhase("connected");
        frontendLog("file_browser_tab", `session ${sessionId} opened for tab ${tabId}`);
        toast.success("Connected", { description: tab.title });
      } catch (err) {
        if (canceled) return;
        setError(String(err));
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
          closeTerminal(sid).catch(() => {});
          setTabSessionId(tabId, null);
        }, 50);
      }
    };
  }, [tabId, setTabSessionId, retryNonce]);

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return (
    <div
      className={`file-browser-tab${isVisible ? "" : " file-browser-tab--hidden"}`}
      data-testid="file-browser-tab"
    >
      <div className="file-browser-tab__body">
        {phase === "connecting" && (
          <>
            <Loader2 size={32} className="file-browser-tab__icon file-browser-tab__spin" />
            <p className="file-browser-tab__heading">Connecting…</p>
            <p className="file-browser-tab__hint">Opening {title || "the connection"}.</p>
          </>
        )}

        {phase === "connected" && (
          <>
            <FolderOpen size={32} className="file-browser-tab__icon" />
            <p className="file-browser-tab__heading">No terminal for this connection</p>
            <p className="file-browser-tab__hint">
              {title ? `${title} browses files instead of running a shell. ` : ""}
              This connection has no terminal output. Use the file browser in the sidebar to
              navigate, open, and transfer files.
            </p>
          </>
        )}

        {phase === "error" && (
          <>
            <AlertCircle
              size={32}
              className="file-browser-tab__icon file-browser-tab__icon--error"
            />
            <p className="file-browser-tab__heading">Could not open connection</p>
            {error && <p className="file-browser-tab__error">{error}</p>}
            <Button
              variant="primary"
              size="sm"
              icon={<RefreshCw size={14} />}
              onClick={handleRetry}
              data-testid="file-browser-tab-retry"
            >
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
