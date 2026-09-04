import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { activeTreeTabs } from "@/store/layoutSelectors";
import {
  remoteDesktopConnect,
  remoteDesktopDisconnect,
  remoteDesktopResize,
  remoteDesktopSendInput,
  remoteDesktopSendClipboard,
  remoteDesktopRemoteClipboardFiles,
  remoteDesktopBindClipboardFiles,
  remoteDesktopCertDecision,
  remoteDesktopRequestFullFrame,
} from "@/services/api";
import {
  onRemoteDesktopState,
  onRemoteDesktopClipboard,
  onRemoteDesktopCertPrompt,
} from "@/services/events";
import type {
  GraphicalSessionState,
  RemoteClipboardFile,
  RemoteDesktopInput,
  RemoteDesktopCertPromptPayload,
  ScaleMode,
} from "@/types/remoteDesktop";
import { frontendLog } from "@/utils/frontendLog";

/** Everything a RemoteDesktopTab needs to drive one graphical session. */
export interface RemoteDesktopSession {
  /** The backend graphical session id, once connected. */
  sessionId: string | null;
  /** Current lifecycle state (drives overlays + the tab state-dot). */
  state: GraphicalSessionState;
  /** Auto-reconnect attempt number (for the reconnecting overlay). */
  reconnectAttempt: number;
  /** Human-readable failure message, when the state carries one. */
  message: string | null;
  /** Latest remote → local clipboard text (for the shared panel). */
  remoteClipboard: string | null;
  /** Pending server-certificate trust prompt (#1767), or null when none. */
  certPrompt: RemoteDesktopCertPromptPayload | null;
  /** Answer the pending cert prompt: accept (once/remember) or reject. */
  respondCert: (accept: boolean, remember: boolean) => void;
  /** Whether the session is configured view-only (input suppressed). */
  viewOnly: boolean;
  /** Configured scale mode (Fit / 1:1 / Match Window). */
  scaleMode: ScaleMode;
  /** Send a protocol-agnostic input event (no-op while view-only/not-active). */
  sendInput: (event: RemoteDesktopInput) => void;
  /** Request a new pixel resolution (Match Window / dynamic resize). */
  resize: (width: number, height: number) => void;
  /** Push local clipboard text to the remote. */
  sendClipboard: (text: string) => void;
  /**
   * List the files the remote copied to its clipboard, surfaced for a local
   * paste (#1804). Empty where the host has no delayed-render binding.
   */
  remoteClipboardFiles: () => Promise<RemoteClipboardFile[]>;
  /**
   * Bind the remote-copied clipboard files onto the host OS clipboard so they
   * can be pasted into any local app (#1804). Resolves to the number bound; the
   * bytes are fetched only on the real paste gesture.
   */
  bindClipboardFiles: () => Promise<number>;
  /** Manually reconnect after a failure or the auto-retry cap. */
  reconnect: () => void;
  /**
   * True while a session adopted from another window (a cross-window tab move,
   * #1904) is waiting for its first repaint. The tab shows the "reconnecting
   * view…" placeholder over the still-blank destination canvas until then.
   */
  awaitingFirstFrame: boolean;
  /** Clear {@link awaitingFirstFrame} once the destination canvas paints a frame. */
  noteFirstFrame: () => void;
}

/**
 * Owns the lifecycle of one graphical remote-desktop session for a tab (#1680).
 *
 * Protocol-blind: it drives the generic `remote_desktop_*` commands and reacts
 * to the generic `remote-desktop-state` / `-clipboard` events, so a VNC or RDP
 * session behaves identically. Frame and cursor painting live in
 * `RemoteDesktopCanvas`, keyed off the returned `sessionId`.
 *
 * The session-ownership lifecycle mirrors `FileBrowserTab`: the owned session is
 * disconnected on unmount with a short deferral so React StrictMode's
 * mount→unmount→mount does not tear down a live session.
 */
export function useRemoteDesktopSession(tabId: string): RemoteDesktopSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<GraphicalSessionState>("connecting");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [certPrompt, setCertPrompt] = useState<RemoteDesktopCertPromptPayload | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Set when this tab adopts a live session handed off from another window
  // (#1904); cleared when the destination canvas paints its first frame.
  const [awaitingFirstFrame, setAwaitingFirstFrame] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const pendingCloseRef = useRef<number | null>(null);
  // Session id to adopt from a cross-window move, resolved once at first render
  // (#1904). A tab hydrated by `moveTabToWindow` carries `pendingScrollbackReplay`
  // + a live `sessionId`; the destination re-attaches to that session instead of
  // opening a fresh connection. `undefined` = not yet resolved; `null` = a
  // normal fresh connect. Held in a ref so it survives StrictMode re-mounts.
  const adoptSessionIdRef = useRef<string | null | undefined>(undefined);

  const setTabSessionId = useAppStore((s) => s.setTabSessionId);

  // Config is read once per (re)connect; it is stable for the tab's lifetime.
  const readTab = useCallback(
    () => activeTreeTabs(useAppStore.getState()).find((t) => t.id === tabId),
    [tabId]
  );

  const tabConfig = readTab()?.config;
  const settings = (tabConfig?.config ?? {}) as Record<string, unknown>;
  const viewOnly = settings.viewOnly === true;
  const scaleMode = (settings.scaleMode as ScaleMode | undefined) ?? "fit";

  // Resolve the adopt-on-move decision exactly once (#1904). A tab hydrated by
  // `moveTabToWindow` carries a live `sessionId` and the `pendingScrollbackReplay`
  // marker; a freshly-opened tab has neither and connects normally.
  if (adoptSessionIdRef.current === undefined) {
    const t = readTab();
    adoptSessionIdRef.current = t?.pendingScrollbackReplay && t?.sessionId ? t.sessionId : null;
  }

  // Connect (and reconnect on retryNonce bump).
  useEffect(() => {
    let canceled = false;

    if (pendingCloseRef.current !== null) {
      clearTimeout(pendingCloseRef.current);
      pendingCloseRef.current = null;
    }

    const connect = async () => {
      const tab = readTab();
      if (!tab) return;
      setState("connecting");
      setMessage(null);
      setReconnectAttempt(0);
      try {
        const id = await remoteDesktopConnect(
          tab.config.type,
          tab.config.config as Record<string, unknown>
        );
        if (canceled) {
          void remoteDesktopDisconnect(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        setSessionId(id);
        setTabSessionId(tabId, id);
        frontendLog("remote_desktop", `session ${id} opened for tab ${tabId}`);
      } catch (err) {
        if (canceled) return;
        setState("connectFailed");
        setMessage(String(err));
      }
    };

    // Cross-window adoption (#1904): on the initial mount of a moved-in tab,
    // re-attach to the still-running session rather than opening a fresh one,
    // and ask the backend for a full frame so the blank destination canvas
    // repaints promptly. A later manual reconnect (retryNonce bump) connects
    // normally. The adopt is idempotent, so a StrictMode re-mount is harmless.
    const adoptId = retryNonce === 0 ? adoptSessionIdRef.current : null;
    if (adoptId) {
      sessionIdRef.current = adoptId;
      setSessionId(adoptId);
      setTabSessionId(tabId, adoptId);
      setState("active");
      setReconnectAttempt(0);
      setMessage(null);
      setAwaitingFirstFrame(true);
      frontendLog("remote_desktop", `adopting moved session ${adoptId} for tab ${tabId}`);
      void remoteDesktopRequestFullFrame(adoptId).catch((err) =>
        frontendLog("remote_desktop", `request_full_frame failed: ${err}`)
      );
      // Consume the one-shot move marker so nothing else acts on it.
      useAppStore.getState().clearPendingScrollbackReplay(tabId);
    } else {
      void connect();
    }

    return () => {
      canceled = true;
      const id = sessionIdRef.current;
      if (id) {
        // Cross-window move (#1904): the destination window adopts this still-
        // running session, so the source must NOT disconnect the backend.
        // Consume the moving flag once and leave the session alive.
        if (useAppStore.getState().isSessionMoving(id)) {
          sessionIdRef.current = null;
          useAppStore.getState().clearMovingSession(id);
          return;
        }
        sessionIdRef.current = null;
        pendingCloseRef.current = window.setTimeout(() => {
          pendingCloseRef.current = null;
          void remoteDesktopDisconnect(id).catch(() => {});
          setTabSessionId(tabId, null);
        }, 50);
      }
    };
  }, [tabId, setTabSessionId, readTab, retryNonce]);

  // Subscribe to lifecycle state + clipboard events for this session.
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    void onRemoteDesktopState((payload) => {
      if (disposed || payload.session_id !== sessionId) return;
      setState(payload.state);
      setReconnectAttempt(payload.reconnect_attempt);
      setMessage(payload.message ?? null);
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    void onRemoteDesktopClipboard((payload) => {
      if (disposed || payload.session_id !== sessionId) return;
      setRemoteClipboard(payload.text);
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    void onRemoteDesktopCertPrompt((payload) => {
      if (disposed || payload.session_id !== sessionId) return;
      setCertPrompt(payload);
      frontendLog("remote_desktop", `cert prompt for ${payload.host} (changed=${payload.changed})`);
    }).then((un) => (disposed ? un() : unlisteners.push(un)));

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, [sessionId]);

  const respondCert = useCallback((accept: boolean, remember: boolean) => {
    const id = sessionIdRef.current;
    // Clear the dialog optimistically; the backend applies the verdict.
    setCertPrompt(null);
    if (!id) return;
    void remoteDesktopCertDecision(id, accept, remember).catch((err) =>
      frontendLog("remote_desktop", `cert_decision failed: ${err}`)
    );
  }, []);

  const sendInput = useCallback(
    (event: RemoteDesktopInput) => {
      const id = sessionIdRef.current;
      if (!id || viewOnly) return;
      void remoteDesktopSendInput(id, event).catch((err) =>
        frontendLog("remote_desktop", `send_input failed: ${err}`)
      );
    },
    [viewOnly]
  );

  const resize = useCallback((width: number, height: number) => {
    const id = sessionIdRef.current;
    if (!id || width <= 0 || height <= 0) return;
    void remoteDesktopResize(id, Math.round(width), Math.round(height)).catch((err) =>
      frontendLog("remote_desktop", `resize failed: ${err}`)
    );
  }, []);

  const sendClipboard = useCallback((text: string) => {
    const id = sessionIdRef.current;
    if (!id) return;
    void remoteDesktopSendClipboard(id, text).catch((err) =>
      frontendLog("remote_desktop", `send_clipboard failed: ${err}`)
    );
  }, []);

  const remoteClipboardFiles = useCallback(async (): Promise<RemoteClipboardFile[]> => {
    const id = sessionIdRef.current;
    if (!id) return [];
    try {
      return await remoteDesktopRemoteClipboardFiles(id);
    } catch (err) {
      frontendLog("remote_desktop", `remote_clipboard_files failed: ${err}`);
      return [];
    }
  }, []);

  const bindClipboardFiles = useCallback(async (): Promise<number> => {
    const id = sessionIdRef.current;
    if (!id) return 0;
    return await remoteDesktopBindClipboardFiles(id);
  }, []);

  const reconnect = useCallback(() => {
    // Tear down any existing session, then re-run the connect effect. A manual
    // reconnect always connects fresh, never re-adopts (#1904).
    const id = sessionIdRef.current;
    if (id) {
      sessionIdRef.current = null;
      void remoteDesktopDisconnect(id).catch(() => {});
    }
    setSessionId(null);
    setAwaitingFirstFrame(false);
    setRetryNonce((n) => n + 1);
  }, []);

  const noteFirstFrame = useCallback(() => {
    // The destination canvas painted a frame after a cross-window adoption
    // (#1904): drop the "reconnecting view…" placeholder.
    setAwaitingFirstFrame(false);
  }, []);

  return {
    sessionId,
    state,
    reconnectAttempt,
    message,
    remoteClipboard,
    certPrompt,
    respondCert,
    viewOnly,
    scaleMode,
    sendInput,
    resize,
    sendClipboard,
    remoteClipboardFiles,
    bindClipboardFiles,
    reconnect,
    awaitingFirstFrame,
    noteFirstFrame,
  };
}
