import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, FolderOpen } from "lucide-react";
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
import { cancelConnecting, createTerminal, closeTerminal } from "@/services/api";
import { fireAndForget, frontendLog } from "@/utils/frontendLog";
import { backendErrorMessage, parseBackendError } from "@/utils/backendErrorCode";
import {
  backendFamilyFromSessionType,
  connectionErrorHint,
  connectionErrorKindFromCode,
  isNetworkErrorKind,
  type ConnectionErrorKind,
} from "@/utils/connectionErrorHints";
import { CONNECTING_TIMEOUT_MS, connectTimeoutMessage } from "@/utils/connectTimeout";
import { ABORTED_CONNECT_MESSAGE } from "@/store/reconnectHelpers";
import { closeTabById, editConnectionForFailure } from "@/utils/connectFailureActions";
import { passwordReentryTarget, setTabPassword } from "@/utils/passwordReentry";
import type { CredentialReentryInput, CredentialReentryTarget } from "@/utils/credentialReentry";
import { formatElapsed } from "@/utils/formatters";
import { getPlatform } from "@/utils/platform";
import { CredentialReentry } from "./CredentialReentry";
import {
  ConnectErrorDetails,
  ConnectFailureActions,
  ConnectFailureHint,
  restingConnectHeading,
  restingConnectPhase,
} from "./ConnectFailure";
import "./FileBrowserTab.css";

interface FileBrowserTabProps {
  tabId: string;
  isVisible: boolean;
}

/** Why the last connect ended without a session (#5377). */
interface ConnectFailure {
  kind: ConnectionErrorKind;
  message: string;
  aborted: boolean;
}

/** One connect attempt: its backend `connectId` and whether it was given up. */
interface ConnectAttempt {
  connectId: string;
  abandoned: boolean;
}

/**
 * Tab body for a terminal-less connection (`Capabilities.terminal === false`,
 * e.g. FTP). Instead of mounting an xterm terminal, it mints and owns the
 * connection's session directly — its own session-creation entry that does not
 * go through the `<Terminal>` component — so the sidebar file browser can route
 * to `tab.sessionId`. The body shows an informational placeholder; the actual
 * browsing happens in the sidebar file browser (#1335).
 *
 * The connect behaves like a terminal tab's (#5377): Abort while connecting,
 * the same client-side deadline ({@link CONNECTING_TIMEOUT_MS}), and a failure
 * screen with a humanised reason, Retry, Edit connection and Close tab.
 *
 * Session lifecycle mirrors `Terminal.tsx`: a session already present on the tab
 * (e.g. pre-minted during credential validation) is adopted rather than
 * re-created, and the owned session is closed on unmount with a short deferral
 * so React StrictMode's mount→unmount→mount does not tear down a live session.
 */
export function FileBrowserTab({ tabId, isVisible }: FileBrowserTabProps) {
  const [phase, setPhase] = useState<"connecting" | "connected" | "failed">("connecting");
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  // Bumped by the retry button to re-run the connect effect.
  const [retryNonce, setRetryNonce] = useState(0);

  const sessionIdRef = useRef<string | null>(null);
  const pendingCloseRef = useRef<number | null>(null);
  const attemptRef = useRef<ConnectAttempt | null>(null);

  const setTabSessionId = useAppStore((s) => s.setTabSessionId);
  // Title is reactive so a rename shows through; the config is read once in the
  // effect since it is stable for the tab's lifetime.
  const title = useAppStore((s) => activeTreeTabs(s).find((t) => t.id === tabId)?.title ?? "");
  const config = useAppStore((s) => activeTreeTabs(s).find((t) => t.id === tabId)?.config);
  const connectionId = useAppStore(
    (s) => activeTreeTabs(s).find((t) => t.id === tabId)?.connectionId
  );
  const identity = connectOverlayIdentity(config ?? { type: "" });
  // The connect ring's elapsed readout counts from the attempt's start.
  const [startedAt, setStartedAt] = useState(() => Date.now());

  /** Give up the in-flight attempt (abort or deadline) and rest on `next`. */
  const abandonAttempt = useCallback((next: ConnectFailure) => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attempt.abandoned = true;
    attemptRef.current = null;
    fireAndForget(
      cancelConnecting(attempt.connectId),
      `cancel file-browser connect ${attempt.connectId}`
    );
    setFailure(next);
    setPhase("failed");
  }, []);

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

      const attempt: ConnectAttempt = {
        connectId: `${tabId}:fb:${crypto.randomUUID()}`,
        abandoned: false,
      };
      attemptRef.current = attempt;
      setPhase("connecting");
      setStartedAt(Date.now());
      setFailure(null);
      try {
        // Name the saved connection (#3876) so a transfer on this session can
        // be resumed after the session is gone.
        const sessionId = await createTerminal(
          tab.config,
          attempt.connectId,
          undefined,
          undefined,
          undefined,
          tab.connectionId
        );
        if (attemptRef.current === attempt) attemptRef.current = null;
        if (canceled || attempt.abandoned) {
          // Superseded by a StrictMode remount, aborted or timed out — tear
          // down the orphan session.
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
        if (attemptRef.current === attempt) attemptRef.current = null;
        if (canceled || attempt.abandoned) return;
        // The backend rejects with a structured `{ code, message }` envelope,
        // not an Error — String() rendered it as "[object Object]" (#4017).
        setFailure({
          kind: connectionErrorKindFromCode(parseBackendError(err).code),
          message: backendErrorMessage(err),
          aborted: false,
        });
        setPhase("failed");
      }
    };

    void connect();

    return () => {
      canceled = true;
      // Closing the tab while connecting aborts the backend connect instead of
      // letting it run on to its timeout.
      const attempt = attemptRef.current;
      if (attempt) {
        attempt.abandoned = true;
        attemptRef.current = null;
        fireAndForget(
          cancelConnecting(attempt.connectId),
          `cancel file-browser connect ${attempt.connectId} on tab close`
        );
      }
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

  // Client-side deadline, the same as a terminal tab's (#1129, #5377): a host
  // that never answers cannot park the tab on the spinner forever.
  useEffect(() => {
    if (phase !== "connecting") return;
    const id = setTimeout(
      () =>
        abandonAttempt({
          kind: "timeout",
          message: connectTimeoutMessage("connecting"),
          aborted: false,
        }),
      Math.max(0, startedAt + CONNECTING_TIMEOUT_MS - Date.now())
    );
    return () => clearTimeout(id);
  }, [phase, startedAt, abandonAttempt]);

  const handleAbort = useCallback(() => {
    abandonAttempt({ kind: "other", message: ABORTED_CONNECT_MESSAGE, aborted: true });
  }, [abandonAttempt]);

  const handleRetry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  const handleClose = useCallback(() => closeTabById(tabId), [tabId]);

  const failureKind = failure?.kind ?? "other";
  const handleEdit = useCallback(() => {
    if (connectionId) editConnectionForFailure(connectionId, failureKind);
  }, [connectionId, failureKind]);

  // A rejected password is re-entered inline, for this attempt only (#5377).
  const reentryTarget = useMemo(
    () => passwordReentryTarget(config, connectionId, false),
    [config, connectionId]
  );
  const handleReenter = useCallback(
    async (_target: CredentialReentryTarget, input: CredentialReentryInput) => {
      setTabPassword(tabId, input.secret);
      setRetryNonce((n) => n + 1);
      return true;
    },
    [tabId]
  );

  const connectingTarget = title || "the connection";
  const typeLabel = connectTypeLabel(identity.sessionType);
  const typeIcon = <FolderOpen size={20} aria-hidden />;
  const target = identity.target || connectingTarget;

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
          target={target}
          typeLabel={typeLabel}
          typeIcon={typeIcon}
          details={identity.details}
          stages={buildStages(stepsFor(identity.sessionType), undefined)}
          status={`Opening ${connectingTarget}.`}
          announcement={`Connecting… Opening ${connectingTarget}.`}
          startedAt={startedAt}
          deadlineAt={startedAt + CONNECTING_TIMEOUT_MS}
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={<Ban size={14} />}
              onClick={handleAbort}
              data-testid="file-browser-tab-abort"
            >
              Abort
            </Button>
          }
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

      {phase === "failed" && failure && (
        <FailureScreen
          failure={failure}
          target={target}
          title={connectingTarget}
          typeLabel={typeLabel}
          typeIcon={typeIcon}
          sessionType={identity.sessionType}
          startedAt={startedAt}
          isVisible={isVisible}
          onRetry={handleRetry}
          onEdit={connectionId ? handleEdit : undefined}
          onClose={handleClose}
          reentry={
            <CredentialReentry tabId={tabId} target={reentryTarget} onSubmit={handleReenter} />
          }
        />
      )}
    </div>
  );
}

/** Props for {@link FailureScreen}. */
interface FailureScreenProps {
  failure: ConnectFailure;
  target: string;
  title: string;
  typeLabel: string;
  typeIcon: React.ReactNode;
  sessionType: string;
  startedAt: number;
  isVisible: boolean;
  onRetry: () => void;
  onEdit?: () => void;
  onClose: () => void;
  reentry: React.ReactNode;
}

/** The resting failed / timed-out / aborted screen, worded like a terminal tab's. */
function FailureScreen({
  failure,
  target,
  title,
  typeLabel,
  typeIcon,
  sessionType,
  startedAt,
  isVisible,
  onRetry,
  onEdit,
  onClose,
  reentry,
}: FailureScreenProps) {
  const phase = restingConnectPhase(failure.aborted, failure.kind);
  const heading = restingConnectHeading(phase, failure.kind);
  const networkFailure =
    phase === "failed" && isNetworkErrorKind(failure.kind) && failure.message !== "";
  const hint = failure.aborted
    ? null
    : connectionErrorHint(backendFamilyFromSessionType(sessionType), failure.kind, getPlatform());
  return (
    <ConnectProgress
      phase={phase}
      heading={heading}
      target={target}
      typeLabel={typeLabel}
      typeIcon={typeIcon}
      startedAt={startedAt}
      error={networkFailure ? undefined : failure.message}
      announcement={[`${heading}.`, `${title}:`, failure.message].join(" ")}
      autoFocusPrimaryAction={isVisible}
      // Only the client's own deadline knows how long it waited.
      timeText={
        failure.message === connectTimeoutMessage("connecting")
          ? `Gave up after ${formatElapsed(Math.round(CONNECTING_TIMEOUT_MS / 1000))}`
          : ""
      }
      actions={
        <ConnectFailureActions
          onRetry={onRetry}
          onEdit={phase === "aborted" ? undefined : onEdit}
          onClose={onClose}
          testIds={{
            retry: "file-browser-tab-retry",
            edit: "file-browser-tab-edit",
            close: "file-browser-tab-close",
          }}
        />
      }
      data-testid="file-browser-tab-error"
    >
      <ConnectFailureHint hint={hint} />
      {networkFailure && <ConnectErrorDetails error={failure.message} />}
      {failure.kind === "auth" && reentry}
    </ConnectProgress>
  );
}
