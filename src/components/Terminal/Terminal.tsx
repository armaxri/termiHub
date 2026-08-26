import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { ConnectionConfig } from "@/types/terminal";
import {
  createTerminal,
  cancelConnecting,
  sendInput,
  setSessionLineEnding,
  sessionLoggingStart,
  resizeTerminal,
  closeTerminal,
  detachPersistentTab,
  getAgentSessionBuffer,
  replaySessionScrollback,
} from "@/services/api";
import { terminalDispatcher } from "@/services/events";
import { useTerminalRegistry } from "./TerminalRegistry";
import {
  useAppStore,
  isResilientReconnectTabId,
  isBackendDrivenAgentReconnectTabId,
} from "@/store/appStore";
import { currentBroadcastView } from "@/store/broadcastBridge";
import { currentAgentsView } from "@/store/agentsBridge";
import { currentSettingsView } from "@/store/settingsBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { getXtermTheme } from "@/themes";
import {
  processKeyEvent,
  isAppShortcut,
  isChordPending,
  isShellReservedKey,
} from "@/services/keybindings";
import { frontendLog } from "@/utils/frontendLog";
import {
  sandboxHasParsers,
  sandboxSessionPending,
  enqueueSandboxTransform,
  sandboxNotifySessionStart,
  sandboxNotifySessionEnd,
  discardSandboxSession,
} from "@/plugins/sandbox/pluginSandboxHost";
import { resolveLineEnding } from "@/utils/lineEndings";
import { getAllLeaves } from "@/utils/panelTree";
import { toast } from "@/components/ui";
import { createTerminalScrollbar, type TerminalScrollbarController } from "./terminalScrollbar";
import { SyntaxHighlightingEngine } from "@/services/syntaxHighlighting";
import { resolveHighlightingConfig, resolveActiveRules } from "@/services/syntaxHighlightingConfig";
import { currentSessionView, waitForBackendAgentReconnectOutcome } from "@/store/sessionBridge";

const HORIZONTAL_SCROLL_COLS = 500;

const DEFAULT_FONT_FAMILY =
  "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;
/** Line height of 1.0 ensures box-drawing characters connect without gaps. */
export const DEFAULT_LINE_HEIGHT = 1.0;
const DEFAULT_SCROLLBACK = 10000;
const DEFAULT_CURSOR_STYLE = "block" as const;
const DEFAULT_CURSOR_BLINK = true;

/**
 * Maximum number of consecutive failed session-spawn attempts for an
 * agent-mediated tab before giving up and surfacing a disconnect error. This
 * bounds the auto-retry loop so a session that can never be created (e.g. the
 * remote command is gone) does not retry forever.
 */
const MAX_AGENT_SPAWN_ATTEMPTS = 5;

/**
 * Resolves a tab's display title from the current store so the connect success
 * toast can name the connection. Falls back to a generic label if the tab has
 * been removed by the time the connect resolves.
 */
function resolveTabTitle(tabId: string): string {
  const state = useAppStore.getState();
  const tab = [
    ...getAllLeaves(state.rootPanel).flatMap((l) => l.tabs),
    ...state.tabGroups.flatMap((g) => getAllLeaves(g.rootPanel).flatMap((l) => l.tabs)),
  ].find((t) => t.id === tabId);
  return tab?.title?.trim() || "Session";
}

/**
 * Wait until the xterm element is sitting in a real slot (large parent
 * container) AND xterm has at least `MIN_REATTACH_COLS` columns.
 *
 * The xterm DOM element is shared across slot remounts: TerminalSlot moves
 * it from a 1×1 hidden parking area into a real container and back. If a
 * state update (e.g. persistent-session-state → "attached") fires during
 * reattach setup, the slot can remount and stash the element back into
 * parking for a few hundred milliseconds. Calling fitAddon.fit() while the
 * element is parked resizes xterm to 2×1, and then `xterm.write(buffer)`
 * renders the scrollback at that doll-house width.
 *
 * Strategy: only call fit() once `el.offsetWidth` looks like a real slot;
 * skip fits against parking entirely so xterm's current cols are not
 * clobbered. Bounded by ~3 s so a misbehaving slot doesn't hang the
 * reattach indefinitely; the buffer is then written at whatever
 * dimensions xterm has, and the normal resize path still attempts to
 * rewrap.
 */
const MIN_REATTACH_COLS = 20;
const MIN_REATTACH_ELEMENT_PX = 50;
const MAX_REATTACH_FIT_FRAMES = 180;
async function waitForUsableDimensions(
  xterm: XTerm,
  fitAddon: FitAddon,
  terminalEl: HTMLDivElement | null,
  isCanceled: () => boolean
): Promise<void> {
  for (let i = 0; i < MAX_REATTACH_FIT_FRAMES; i++) {
    const elWidth = terminalEl?.offsetWidth ?? 0;
    if (elWidth >= MIN_REATTACH_ELEMENT_PX) {
      try {
        fitAddon.fit();
      } catch {
        // Container not measurable yet — retry on the next frame.
      }
      if (xterm.cols >= MIN_REATTACH_COLS) return;
    }
    if (isCanceled()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/**
 * Scan the terminal buffer and return the rightmost occupied cell index.
 * Efficiently skips lines shorter than the current maximum.
 */
function getMaxLineCells(xterm: XTerm): number {
  const buffer = xterm.buffer.active;
  let maxCells = 0;
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    for (let x = line.length - 1; x >= maxCells; x--) {
      const cell = line.getCell(x);
      if (cell && cell.getChars() !== "") {
        maxCells = x + 1;
        break;
      }
    }
  }
  return maxCells;
}

/**
 * Set the visual scroll width based on the actual buffer content.
 * Width is at least the viewport width (fittedCols) so the scrollbar
 * only appears when content is actually wider.
 */
function updateHorizontalScrollWidth(xterm: XTerm, fitAddon: FitAddon, _container: HTMLElement) {
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.cols <= 0) return;

  // Use the actual rendered cell width from xterm's render service — the same
  // source FitAddon uses internally. FitAddon already subtracted the scrollbar
  // width from the available width before computing dims.cols, so using the
  // true cell width here ensures targetWidth stays within the scrollbar-free
  // area. Using container.clientWidth / dims.cols would produce a slightly
  // inflated cell width (full width ÷ reduced cols), pushing targetWidth back
  // to full container width and hiding content under the right-side scrollbar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cellWidth: number = (xterm as any)._core?._renderService?.dimensions?.css?.cell?.width;
  if (!cellWidth || cellWidth <= 0) return;

  const contentCols = getMaxLineCells(xterm);
  const effectiveCols = Math.max(contentCols, dims.cols);
  const targetWidth = Math.ceil(effectiveCols * cellWidth);

  const xtermEl = xterm.element;
  if (xtermEl) {
    xtermEl.style.width = targetWidth + "px";
    const screen = xtermEl.querySelector(".xterm-screen") as HTMLElement | null;
    if (screen) {
      screen.style.width = targetWidth + "px";
    }
  }
}

/**
 * Resize the PTY to a wide column count (prevents wrapping) and set
 * the visual scroll width to match the actual content.
 */
function applyHorizontalScrollResize(xterm: XTerm, fitAddon: FitAddon, container: HTMLElement) {
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.cols <= 0) return;

  xterm.resize(HORIZONTAL_SCROLL_COLS, dims.rows);
  updateHorizontalScrollWidth(xterm, fitAddon, container);
}

/**
 * Remove horizontal scrolling layout and restore normal fit.
 */
function removeHorizontalScrollResize(xterm: XTerm, fitAddon: FitAddon) {
  const xtermEl = xterm.element;
  if (xtermEl) {
    xtermEl.style.width = "";
    const screen = xtermEl.querySelector(".xterm-screen") as HTMLElement | null;
    if (screen) {
      screen.style.width = "";
    }
  }
  fitAddon.fit();
}

/**
 * Resolve the effective line ending for a tab (per-connection override > global
 * default > LF) and push it to the backend so its `send_input` choke point
 * normalizes this session's input. Resolved imperatively from the store so it
 * works from both the establishment flow and the settings-change effect.
 */
async function pushLineEnding(tabId: string, sessionId: string): Promise<void> {
  const s = useAppStore.getState();
  const ending = resolveLineEnding(
    s.tabTerminalOptions[tabId]?.lineEnding,
    currentSettingsView().defaultLineEnding
  );
  try {
    await setSessionLineEnding(sessionId, ending);
  } catch (e) {
    frontendLog("terminal", `failed to set line ending for session ${sessionId}: ${String(e)}`);
  }
}

/**
 * Auto-start per-session output logging when the connection opts in (#1960).
 *
 * Reads the per-connection `logToFile` / `logTimestamps` terminal options and,
 * when enabled, starts logging to the default `<connection>-<timestamp>.log`
 * location. Best-effort: a failure is logged but never blocks establishment,
 * and the toolbar toggle remains available regardless.
 */
async function pushSessionLogging(tabId: string, sessionId: string): Promise<void> {
  const options = useAppStore.getState().tabTerminalOptions[tabId];
  if (!options?.logToFile) return;
  try {
    await sessionLoggingStart(sessionId, undefined, options.logTimestamps ?? false);
  } catch (e) {
    frontendLog("terminal", `failed to start session logging for ${sessionId}: ${String(e)}`);
  }
}

interface TerminalProps {
  tabId: string;
  config: ConnectionConfig;
  isVisible: boolean;
  existingSessionId?: string | null;
  /** Optional command to send after the session connects. */
  initialCommand?: string;
  /** When set, closing this tab detaches from the persistent session instead of killing it. */
  persistentConnectionId?: string;
  /**
   * `true` when this tab was opened via the CLI/context-menu spawn path (#1446,
   * #1466). Forwarded to the backend on connect so the spawned origin is
   * recorded on the session registry — the source of truth the Open Connections
   * panel groups "Spawned Containers" from, surviving this tab's close.
   */
  spawned?: boolean;
  /**
   * `true` when this tab was hydrated into a destination window by a "move to
   * window" re-parent (#1900). On (re)attach the terminal fetches and replays
   * the session's ring-buffered scrollback once so the fresh xterm repaints
   * history. Ignored for persistent tabs (they replay via the agent buffer).
   */
  replayScrollbackOnAttach?: boolean;
}

/**
 * Manages an xterm.js instance and its PTY backend connection.
 * Creates an imperative DOM element registered with the TerminalRegistry.
 * Renders nothing — TerminalSlot handles display by adopting the DOM element.
 */
export function Terminal({
  tabId,
  config,
  isVisible,
  existingSessionId,
  initialCommand,
  persistentConnectionId,
  spawned,
  replayScrollbackOnAttach,
}: TerminalProps) {
  const retryCount = useAppStore((s) => s.terminalRetryCounters[tabId] ?? 0);
  const terminalElRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const scrollbarRef = useRef<TerminalScrollbarController | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // Per-terminal syntax-highlighting engine (epic #1696). Created alongside the
  // xterm instance and disposed on the same boundary, so a reconnect (retryCount
  // bump re-runs the creation effect) rebuilds it cleanly. Null while no xterm
  // exists.
  const highlightEngineRef = useRef<SyntaxHighlightingEngine | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Serialized scrollback of the previous xterm instance, captured just before
  // it is disposed on a reconnect (retryCount bump re-runs the creation effect
  // and tears the instance down). Replayed into the fresh xterm so the
  // scrollback the disconnect overlay promises survives — and, if the reconnect
  // itself fails, is still visible under the "Reconnect failed" overlay (#1126).
  const scrollbackSnapshotRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // The set of connect ids (`${tabId}:${retryCount}`) whose backend handshake is
  // currently in flight, so teardown can abort them (#952). Tracked PER attempt
  // rather than as a single shared boolean: overlapping attempts each add/remove
  // their own id, so a stale attempt that settles late can no longer clear the
  // flag out from under a live attempt and skip its cancel on teardown (#1214).
  const connectInFlightRef = useRef<Set<string>>(new Set());
  const horizontalScrollingRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const lastInputTimeRef = useRef(0);
  const contentDirtyRef = useRef(false);
  // Whether the WebGL renderer is currently driving this terminal (#2107). The
  // WebGL addon repaints its whole canvas each frame, so the per-flush full-
  // viewport refresh (a DOM-renderer paint fix for #1849) is redundant work
  // under WebGL. Gated on this ref so the refresh is skipped while WebGL is
  // active but resumes the moment the context is lost and xterm falls back to
  // the DOM renderer mid-session. Lives at component scope so the output-flush
  // effect and the terminal-init effect (which owns the addon) share it.
  const webglRendererActiveRef = useRef(false);
  const pendingCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isViewModeRef = useRef(false);
  // Capture existingSessionId at mount time only. After the Terminal creates a
  // session, TerminalRegistry.registerSession writes the session ID back to the
  // Zustand store (via setTabSessionId) so the file browser can observe it.
  // That store update propagates the session ID back as the existingSessionId
  // prop, which would change setupTerminal's closure and trigger a re-setup —
  // destroying the live xterm and leaving a blank terminal. Using a mount-time
  // ref keeps setupTerminal stable after the initial connect.
  const initialSessionIdRef = useRef(existingSessionId);
  // One-shot: replay the moved session's scrollback on the first attach after a
  // cross-window re-parent (#1900). Captured at mount so a later store write does
  // not re-trigger it; cleared once consumed.
  const replayScrollbackRef = useRef(replayScrollbackOnAttach);
  // Keep the latest persistentConnectionId in a ref so the terminal-creation
  // effect below can read it without listing it as a dependency. Adding it to
  // that effect's deps would dispose and recreate the live xterm instance and
  // its backend session whenever the prop changed — the same churn we avoid for
  // existingSessionId above. The value is only read on (re)connect to decide
  // whether to replay the local scrollback snapshot, so a ref preserves the
  // exact behavior while satisfying react-hooks/exhaustive-deps (#1271).
  const persistentConnectionIdRef = useRef(persistentConnectionId);
  useEffect(() => {
    persistentConnectionIdRef.current = persistentConnectionId;
  }, [persistentConnectionId]);
  const {
    register,
    unregister,
    getSessionId,
    registerSession,
    unregisterSession,
    copySelectionToClipboard,
    pasteToTerminal,
    registerSearchAddon,
    parkingRef,
  } = useTerminalRegistry();

  // Keep the view-mode ref in sync so the key handler (registered once per xterm
  // instance) can consult current state without being recreated on every render.
  useEffect(() => {
    isViewModeRef.current = useAppStore.getState().terminalViewMode[tabId] ?? false;
    return useAppStore.subscribe((state) => {
      isViewModeRef.current = state.terminalViewMode[tabId] ?? false;
    });
  }, [tabId]);

  const setupTerminal = useCallback(
    async (xterm: XTerm, fitAddon: FitAddon, isCanceled: () => boolean, connectId: string) => {
      // Cancel any pending session close from a StrictMode unmount cycle
      if (pendingCloseTimerRef.current !== null) {
        clearTimeout(pendingCloseTimerRef.current);
        pendingCloseTimerRef.current = null;
      }

      try {
        // Ensure the global Tauri event listener is registered before
        // creating the backend session — otherwise early output events
        // emitted by the PTY reader thread are silently lost.
        await terminalDispatcher.init();
        if (isCanceled()) return;

        // Fit to the actual container dimensions before creating the session.
        // The initial fit in the outer effect runs while the element is in
        // "parking" (hidden, zero-size), so xterm.cols is still the 80-col
        // default at that point.  Fitting here — after the element has been
        // moved to its real slot by the portal system — gives the correct
        // terminal width.  This width is injected into the connection config
        // so the backend uses it for PTY sizing and the OSC 7 erase
        // calculation, which must know how many lines the echo occupies.
        try {
          fitAddon.fit();
        } catch {
          // Container not yet sized; fall back to current xterm dimensions
        }
        // Build a config that carries the actual terminal dimensions so the
        // backend creates the PTY at the right size and calculates the OSC 7
        // line-erase correctly.  Only override cols/rows when they are valid
        // (> 0); otherwise keep whatever the connection config specifies.
        const sessionConfig: typeof config =
          xterm.cols > 0 && xterm.rows > 0
            ? {
                ...config,
                config: {
                  ...(config.config as Record<string, unknown>),
                  cols: xterm.cols,
                  rows: xterm.rows,
                },
              }
            : config;

        // Determine connection mode. Remote-session tabs (agent-mediated) use
        // auto-retry on failure; direct connections use user-driven retry.
        const isAgentSession = config.type === "remote-session";
        const agentId = isAgentSession
          ? (config.config as { agentId?: string }).agentId
          : undefined;

        // ── Connection loop ────────────────────────────────────────────────
        // For workspace-restore the session already exists — skip the loop.
        // ptyCols/ptyRows capture the dimensions passed to createTerminal so
        // we can initialize the resize-deduplication tracking below.
        let ptyCols = 0;
        let ptyRows = 0;
        let sessionId: string;

        // Decide whether to reattach to an existing session or start fresh.
        // On the initial mount we reattach to the session captured at mount
        // time (workspace restore / persistent attach). On a reconnect
        // (retryCount > 0) that session is dead — reattaching to it would wire
        // the tab to a corpse and the reconnect would spin forever. So instead
        // we start fresh: a persistent tab restarts its background session and
        // reattaches to the new live id; any other tab creates a new session.
        const isReconnect = (useAppStore.getState().terminalRetryCounters[tabId] ?? 0) > 0;
        // "Start new shell" (#2512): the one-shot force-fresh flag makes this
        // reconnect create a brand-new session instead of re-attaching an
        // unrecoverable one. Consumed here so a later reconnect re-attaches as
        // usual.
        const forceFresh = useAppStore.getState().terminalForceFreshReconnect[tabId] ?? false;
        if (forceFresh) {
          useAppStore.setState((s) => {
            const next = { ...s.terminalForceFreshReconnect };
            delete next[tabId];
            return { terminalForceFreshReconnect: next };
          });
        }
        let reattachSessionId: string | null;
        if (isReconnect) {
          if (forceFresh) {
            // Skip every re-attach branch: a fresh `create_connection` below opens
            // a new shell for the tab (an explicit user choice on the session-lost
            // notice, where auto re-attach is deliberately suppressed).
            reattachSessionId = null;
          } else if (persistentConnectionId) {
            // Persistent/agent tab: restart the background session and reattach
            // to its (possibly new) live id — never to the dead mount-time id.
            reattachSessionId = await useAppStore.getState().restartPersistentSessionForTab(tabId);
          } else if (currentSessionView()[tabId]?.status === "reconnecting") {
            // Backend-driven automatic reconnect (#2205 PR-B): a genuine drop folded
            // the `session-lifecycle` region to `reconnecting` and the backend
            // redrive is the SOLE reconnect authority — it re-establishes the
            // transport (agent or direct SSH), mints a fresh backend session id and
            // publishes it to the region, parking/retrying for however long the drop
            // lasts. The client must NOT drive the transport in parallel — its create
            // loop / agent engine are non-idempotent and would double-drive the very
            // transport the backend is re-establishing. So wait for the backend
            // loop's terminal outcome and never fall through to the client create
            // below:
            //   • reattach    → attach I/O to the fresh backend session id;
            //   • giveup      → settle the tab disconnected (backend exhausted);
            //   • sessionLost → the transport came back but the live agent session
            //                   was unrecoverable (#2512);
            //   • canceled    → the effect was torn down.
            const outcome = await waitForBackendAgentReconnectOutcome(
              tabId,
              sessionIdRef.current,
              isCanceled
            );
            if (isCanceled() || outcome.kind === "canceled") return;
            if (outcome.kind === "giveup") {
              useAppStore
                .getState()
                .settleBackendReconnectGaveUp(tabId, outcome.error ?? "Reconnect failed.");
              return;
            }
            if (outcome.kind === "sessionLost") {
              // The transport came back but the live agent session was
              // unrecoverable (#2512). Never silently mint a replacement: settle
              // the tab into the terminal session-lost state, whose overlay offers
              // an explicit "start new shell" action.
              useAppStore.getState().settleSessionLost(tabId);
              return;
            }
            reattachSessionId = outcome.sessionId;
          } else {
            // User-initiated reconnect (the region is not reconnecting — the user
            // clicked Reconnect / Try Again after a disconnect or give-up): start
            // fresh via the client `create_connection` below, exactly as an initial
            // connect does. `setTerminalConnecting(true)` there dispatches
            // `session.connect`, resetting the region to `connecting`.
            reattachSessionId = null;
          }
          if (isCanceled()) return;
        } else {
          reattachSessionId = initialSessionIdRef.current ?? null;
        }

        if (reattachSessionId) {
          sessionId = reattachSessionId;
          // Clear the pre-connect overlay state that reconnectTerminal set
          // (terminalConnecting=true to show the overlay immediately). Only the
          // createTerminal path below clears these otherwise. This must happen
          // BEFORE the reattach buffer replay: SplitView keeps the xterm element
          // parked while terminalConnecting is set, which would starve
          // waitForUsableDimensions of a real width and render the scrollback at
          // ~2 columns. The terminalReattaching flag set below still shows the
          // overlay during the fetch.
          useAppStore.getState().setTerminalConnecting(tabId, false);
          useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
          useAppStore.getState().setTerminalSpawnError(tabId, null);
          if (persistentConnectionId) {
            // Show the reattaching overlay while we fetch and replay the scrollback buffer.
            useAppStore.getState().setTerminalReattaching(tabId, true);
            // Clear any exit that arrived for this session before we subscribed.
            // This prevents a stale exit from a previous attachment (e.g. temporary
            // agent-connection drop that was since recovered) from firing as "[Process
            // exited]" on the new tab.  Any exit that fires AFTER this point will be
            // buffered and delivered when subscribeExit is called below.
            terminalDispatcher.clearPendingExit(sessionId);
            frontendLog("terminal", `Reattaching persistent session ${sessionId}, fetching buffer`);
            try {
              const buffer = await getAgentSessionBuffer(sessionId);
              if (isCanceled()) return;
              if (buffer.length > 0) {
                // Drop the reattaching flag BEFORE writing the buffer.
                // SplitView swaps TerminalSlot for TerminalConnectionOverlay
                // while the flag is true (see SplitView.tsx ~660), which
                // unmounts the slot and parks the xterm element in the 1x1
                // hidden container.  Writing the buffer then renders the
                // scrollback at parking dimensions (e.g. 2x1), and xterm.js's
                // later reflow cannot recover the trailing prompt because zsh
                // emits per-character cursor-positioning sequences.  Clearing
                // the flag now lets the slot remount and re-adopt the element
                // back into its real container; the wait below blocks until
                // that has happened.
                useAppStore.getState().setTerminalReattaching(tabId, false);
                await waitForUsableDimensions(xterm, fitAddon, terminalElRef.current, isCanceled);
                if (isCanceled()) return;
                // DEBUG/reattach: confirm dimensions + container size after the wait.
                frontendLog(
                  "terminal",
                  `DEBUG/reattach buffer=${buffer.length}B writing at xterm=${xterm.cols}x${xterm.rows} el=${terminalElRef.current?.offsetWidth ?? 0}x${terminalElRef.current?.offsetHeight ?? 0}`
                );
                xterm.reset();
                await new Promise<void>((resolve) => xterm.write(buffer, resolve));
                // NOTE: clearPendingOutput is intentionally deferred to right
                // before subscribeOutput below.  `attach_session` on the agent
                // (called via reconnect_existing during apiAttachPersistentTab)
                // triggers the daemon to forward its ring buffer as live
                // `connection.output` notifications — and those chunks keep
                // arriving while `xterm.write(buffer)` is still running.
                // Clearing here would miss the in-flight chunks; they would
                // accumulate in pendingOutput and get re-drained by
                // subscribeOutput, duplicating every byte of scrollback.
              }
            } catch (err) {
              frontendLog("terminal", `Failed to fetch reattach buffer: ${err}`);
            } finally {
              // Idempotent: clears the flag in the empty-buffer + error paths
              // where the early clear above did not run.
              if (!isCanceled()) {
                useAppStore.getState().setTerminalReattaching(tabId, false);
              }
            }
            if (isCanceled()) return;
          } else if (replayScrollbackRef.current) {
            // Cross-window re-parent (#1900): the backend session kept running,
            // so repaint history from its 1 MiB ring buffer into this fresh
            // xterm. Mirrors the persistent-reattach replay dance above.
            useAppStore.getState().setTerminalReattaching(tabId, true);
            frontendLog("terminal", `Replaying scrollback for moved session ${sessionId}`);
            try {
              const buffer = await replaySessionScrollback(sessionId);
              if (isCanceled()) return;
              if (buffer.length > 0) {
                useAppStore.getState().setTerminalReattaching(tabId, false);
                await waitForUsableDimensions(xterm, fitAddon, terminalElRef.current, isCanceled);
                if (isCanceled()) return;
                xterm.reset();
                await new Promise<void>((resolve) => xterm.write(buffer, resolve));
              }
            } catch (err) {
              frontendLog("terminal", `Failed to replay moved-session scrollback: ${err}`);
            } finally {
              if (!isCanceled()) {
                useAppStore.getState().setTerminalReattaching(tabId, false);
              }
              // One-shot: clear the tab flag so a later render never replays again.
              replayScrollbackRef.current = false;
              useAppStore.getState().clearPendingScrollbackReplay(tabId);
            }
            if (isCanceled()) return;
          }
        } else {
          let attempt = 0;
          let resolved: string | null = null;

          while (!isCanceled()) {
            useAppStore.getState().setTerminalConnecting(tabId, true);

            try {
              // Capture dims immediately before creating the PTY so we know
              // what size it was created with (xterm.cols may change while
              // createTerminal is awaiting if a container resize fires).
              ptyCols = xterm.cols;
              ptyRows = xterm.rows;
              // Pass a UNIQUE per-attempt connect id so closing the tab while
              // connecting can abort the in-flight handshake (#952) — and so an
              // overlapping retry/reconnect never shares the previous attempt's
              // id. If it did, the old effect's cleanup would cancel the fresh
              // attempt's token instead of its own (#1125).
              connectInFlightRef.current.add(connectId);
              try {
                // Pass the tab's resilient-reconnect determination (#2439) so a
                // genuine drop is folded server-side as `session.reconnect` vs
                // `session.dropped`, converging with `setTerminalExited`. Computed
                // from the live store the same way the client's drop path does.
                const resilientReconnect = isResilientReconnectTabId(tabId);
                resolved = await createTerminal(
                  sessionConfig,
                  connectId,
                  spawned,
                  resilientReconnect
                );
              } finally {
                connectInFlightRef.current.delete(connectId);
              }

              if (isCanceled()) {
                closeTerminal(resolved);
                return;
              }
              // Success — clear all pre-connect overlay state and give the user
              // a brief, non-intrusive confirmation that the session is live so
              // the connect does not resolve silently (#1127).
              useAppStore.getState().setTerminalConnecting(tabId, false);
              useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
              useAppStore.getState().setTerminalSpawnError(tabId, null);
              toast.success("Connected", { description: resolveTabTitle(tabId) });
              break;
            } catch (err) {
              if (isCanceled()) return;
              useAppStore.getState().setTerminalConnecting(tabId, false);

              if (isAgentSession && agentId) {
                // The client create loop is only reached for an initial connect or a
                // user-initiated reconnect (the region-`reconnecting` branch above
                // awaits the backend redrive and never falls through here), so the
                // backend is not driving this tab in parallel — the client agent
                // engine (connectRemoteAgent + park + bounded MAX_AGENT_SPAWN_ATTEMPTS)
                // is the correct driver, with no double-drive risk (#2205 PR-B).
                //
                // Check whether the agent transport itself is still connecting.
                const agentState = currentAgentsView().remoteAgents.find(
                  (a) => a.id === agentId
                )?.connectionState;

                if (agentState === "connecting" || agentState === "reconnecting") {
                  // Park tab; TerminalView wakes it via retryTerminalSpawn
                  // once the agent emits "connected".
                  useAppStore.getState().setTerminalWaitingForAgent(tabId, agentId);
                  return;
                }

                if (agentState === "disconnected") {
                  // The agent transport itself is gone — retrying createTerminal
                  // would fail with "Agent not connected" forever. Re-establish
                  // the agent connection and park the tab; TerminalView wakes it
                  // (retryTerminalSpawn) once the agent emits "connected", at
                  // which point a fresh session is created. This is what makes
                  // reconnect actually restart the connection instead of looping.
                  useAppStore.getState().setTerminalWaitingForAgent(tabId, agentId);
                  void useAppStore
                    .getState()
                    .connectRemoteAgent(agentId)
                    .catch((e) => {
                      const s = useAppStore.getState();
                      // Only surface the failure if this tab is still parked on
                      // this agent (avoid clobbering a state another path set).
                      if (s.terminalWaitingForAgent[tabId] === agentId) {
                        s.setTerminalWaitingForAgent(tabId, null);
                        s.setTerminalDisconnectWithError(
                          tabId,
                          `Could not reconnect to agent: ${e instanceof Error ? e.message : String(e)}`
                        );
                      }
                    });
                  return;
                }

                // Agent is up but the session creation failed. Bound the retries
                // so a session that can never be created surfaces an error
                // instead of spinning forever.
                attempt++;
                if (attempt > MAX_AGENT_SPAWN_ATTEMPTS) {
                  useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
                  useAppStore.getState().setTerminalSpawnError(tabId, null);
                  useAppStore.getState().setTerminalDisconnectWithError(tabId, String(err));
                  return;
                }

                // Show a brief "Connection failed" state so the user can see
                // each attempt's outcome, then auto-retry.  Clear the retry
                // counter first so the failure state is not hidden by the
                // "Connecting… (attempt N)" overlay (which has higher priority).
                useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
                useAppStore.getState().setTerminalSpawnError(tabId, String(err));

                // 3 s visible failure display (cancellable via isCanceled or user retry).
                const failDeadline = Date.now() + 3000;
                while (Date.now() < failDeadline) {
                  if (isCanceled()) return;
                  await new Promise<void>((r) => setTimeout(r, 100));
                }
                if (isCanceled()) return;

                // Transition to "Connecting… (attempt N)" for the retry countdown.
                // setTerminalAutoRetrying also clears terminalConnecting.
                useAppStore.getState().setTerminalAutoRetrying(tabId, attempt);

                // 2.5 s cancellable delay before the next createTerminal attempt.
                const deadline = Date.now() + 2500;
                while (Date.now() < deadline) {
                  if (isCanceled()) return;
                  await new Promise<void>((r) => setTimeout(r, 100));
                }
              } else {
                // Direct connection (SSH, Telnet, serial, local) — show error.
                useAppStore.getState().setTerminalSpawnError(tabId, String(err));
                return;
              }
            }
          }

          if (isCanceled() || resolved === null) return;
          sessionId = resolved;
        }
        // ── End connection loop ────────────────────────────────────────────

        sessionIdRef.current = sessionId;
        registerSession(tabId, sessionId);

        // Push the resolved line ending to the backend BEFORE wiring onData, so
        // the session's send_input normalizes from the very first keystroke.
        // Awaited to avoid an IPC ordering race where early input on a CR/CRLF
        // connection would be sent with the backend's default (LF). This is the
        // single point every establishment path (fresh create, reattach,
        // reconnect) passes through; later setting changes are synced by the
        // effect below.
        await pushLineEnding(tabId, sessionId);

        // Auto-start per-session output logging when the connection opts in
        // (#1960). Idempotent on the backend, so reattach/reconnect paths that
        // pass through here again do not double-open the transcript.
        await pushSessionLogging(tabId, sessionId);

        // Resize-deduplication: track the last (cols, rows) sent to the PTY
        // to avoid spurious SIGWINCH signals.  Multiple rapid fit() calls
        // (slot adoption sync+RAF, ResizeObserver, visibility effect) all
        // fire xterm.onResize, but only a genuine dimension change should
        // trigger a PTY resize.  Initialized to the dims used to create the
        // PTY (ptyCols/ptyRows) so the post-setup explicit resize is skipped
        // when nothing changed; stays at 0 for workspace-restore so the
        // first resize always fires to re-sync with the existing PTY.
        let lastSentCols = ptyCols;
        let lastSentRows = ptyRows;

        // Output batching: buffer chunks and flush in a single RAF callback.
        const outputBuffer: Uint8Array[] = [];
        let rafId: number | null = null;
        // Fallback timer paired with the RAF (#2136): when a plugin protocol
        // parser is active, transformed output is pushed to the buffer from a
        // Worker `message` turn, and a `requestAnimationFrame` armed in that turn
        // is not always serviced by the WebView (no paint is scheduled for an
        // unfocused window), so the buffer would never flush. A plain timer fires
        // regardless of paint scheduling; whichever runs first flushes and clears
        // the other. The no-plugin fast path still flushes on the very next RAF.
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushOutput = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          if (outputBuffer.length === 0) return;

          // xterm.js 6's SmoothScrollableElement updates its scroll range
          // during the render pass (requestAnimationFrame), which runs
          // AFTER the write callback.  Calling scrollToBottom() in the
          // write callback is too early — the scroll range still reflects
          // the old content height.  Defer to a RAF so the render pass
          // completes first and scrollToBottom() targets the correct
          // position.
          //
          // The same RAF also forces a full-viewport repaint. xterm's DOM
          // renderer only repaints rows it has marked dirty; during rapid
          // scrolling output — e.g. Windows ConPTY redrawing a `git status`
          // with many untracked files — WebView2/WebKit can leave rows painted
          // at stale vertical positions, so a later prompt line appears spliced
          // into earlier output until a resize forces a full re-render (#1849).
          // Refreshing every visible row after each flush makes the paint
          // deterministic without a manual resize, mirroring the #1823 fit+
          // refresh fix. The range is bounded by the viewport height (the same
          // rows a scroll already repaints), so it stays cheap on high-
          // throughput output. Runs regardless of scroll position so stale rows
          // are corrected even when the user has scrolled up.
          //
          // Skip it while the WebGL renderer is active (#2107): WebGL repaints
          // its whole canvas each frame and never exhibits the #1849 stale-row
          // bug, so the forced refresh is pure overhead there. The ref flips
          // back to false on WebGL context loss, so the refresh resumes for the
          // DOM fallback path.
          const afterWrite = () => {
            requestAnimationFrame(() => {
              if (!userScrolledUpRef.current) {
                xterm.scrollToBottom();
              }
              if (!webglRendererActiveRef.current) {
                xterm.refresh(0, Math.max(0, xterm.rows - 1));
              }
            });
          };

          if (outputBuffer.length === 1) {
            xterm.write(outputBuffer[0], afterWrite);
          } else {
            // Concatenate all buffered chunks into one write
            let totalLen = 0;
            for (const chunk of outputBuffer) totalLen += chunk.length;
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const chunk of outputBuffer) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }
            xterm.write(merged, afterWrite);
          }
          outputBuffer.length = 0;
        };

        // Discard any output that landed in pendingOutput while we were
        // fetching + writing the scrollback buffer.  For persistent reattach,
        // those chunks are the daemon's MSG_BUFFER_REPLAY (forwarded as live
        // `connection.output` by the agent in response to attach_session) and
        // duplicate bytes we just rendered from getAgentSessionBuffer.  Doing
        // this synchronously immediately before subscribeOutput ensures no
        // additional chunks slip into pendingOutput between the clear and
        // the subscription registration.
        if (persistentConnectionId) {
          terminalDispatcher.clearPendingOutput(sessionId);
        }

        // Notify sandboxed frontend-plugin protocol parsers that this session
        // started (#1998), so a parser can reset any per-session state before
        // output begins flowing.
        sandboxNotifySessionStart(sessionId);

        // Schedule a batched flush on the next animation frame, with a timer
        // fallback so output still flushes when RAF is starved (#2136 — see the
        // note on `flushTimer`). Both are cleared in flushOutput.
        const scheduleFlush = () => {
          if (rafId === null) {
            rafId = requestAnimationFrame(flushOutput);
          }
          if (flushTimer === null) {
            flushTimer = setTimeout(flushOutput, 16);
          }
        };

        // Subscribe to output events via singleton dispatcher (O(1) routing)
        const unsubOutput = terminalDispatcher.subscribeOutput(sessionId, (data) => {
          // Frontend-plugin protocol parsers now run in a sandbox worker (#2136),
          // so applying them is asynchronous. FAST PATH: when no parser is
          // registered (the default-off common case) and this session has no
          // in-flight sandbox work, push the raw bytes synchronously — byte-exact,
          // identical to the pre-sandbox path. Otherwise route the chunk through
          // the sandbox host, which returns the (possibly transformed) bytes in
          // arrival order via the callback.
          if (!sandboxHasParsers() && !sandboxSessionPending(sessionId)) {
            outputBuffer.push(data);
            scheduleFlush();
            return;
          }
          enqueueSandboxTransform(sessionId, data, (out) => {
            outputBuffer.push(out);
            scheduleFlush();
          });
        });

        // Subscribe to exit events via singleton dispatcher
        frontendLog("disconnect", `subscribed exit for session=${sessionId} tab=${tabId}`);
        const unsubExit = terminalDispatcher.subscribeExit(sessionId, (exitCode) => {
          // Classify why the session ended so the disconnect overlay can tailor
          // its wording (#1121). A user-initiated kill (e.g. from the Open
          // Connections panel) was tagged beforehand; otherwise exit code 0 is a
          // clean exit and anything else (or an unknown code) is a dropped/failed
          // session.
          const store = useAppStore.getState();
          const wasKilled = store.consumeSessionKilled(sessionId);
          const reason = wasKilled ? "killed" : exitCode === 0 ? "clean" : "dropped";
          frontendLog(
            "disconnect",
            `terminal-exit fired session=${sessionId} tab=${tabId} code=${exitCode} reason=${reason}`
          );
          const exitLabel =
            exitCode === null ? "[Process exited]" : `[Process exited with code ${exitCode}]`;
          xterm.writeln(`\r\n\x1b[90m${exitLabel}\x1b[0m`);
          // Notify sandboxed frontend-plugin protocol parsers the session ended (#1998).
          sandboxNotifySessionEnd(sessionId);
          sessionIdRef.current = null;
          unregisterSession(tabId);
          store.setTerminalExited(tabId, { code: exitCode, reason });
        });

        // Send user input to backend
        const onDataDisposable = xterm.onData((data) => {
          lastInputTimeRef.current = Date.now();
          const store = useAppStore.getState();
          // Broadcast fan-out (#1955): when this terminal is the active
          // broadcast source, mirror typed input to every connected target
          // session instead of only this one. The source tab is included in the
          // target set, so the loop is uniform (no separate self-send).
          // Non-source terminals and the inactive state fall through to the
          // normal single-session path below. Context-menu/native paste flows
          // through onData and is broadcast here; keyboard-shortcut paste is
          // preventDefault'd and broadcast in pasteToTerminal instead (#1981).
          const bcView = currentBroadcastView();
          if (bcView.active && bcView.sourceTabId === tabId) {
            for (const targetTabId of store.getBroadcastTargetTabIds()) {
              const targetSessionId = getSessionId(targetTabId);
              // Fire-and-forget, dispatched in parallel; line-ending
              // translation happens in the backend send_input choke point.
              if (targetSessionId) sendInput(targetSessionId, data);
            }
            // Tap the input stream for macro recording (#1674) once, for the
            // source's keystrokes only. No-op unless a recording is active.
            store.recordMacroInput(data);
          } else if (sessionIdRef.current) {
            // Line-ending translation (Enter / paste) happens in the backend
            // send_input choke point using the session's configured ending.
            sendInput(sessionIdRef.current, data);
            // Tap the input stream for macro recording (#1674). This is the
            // single point where user-typed bytes flow to the PTY, so it
            // captures input only (never terminal output). No-op unless a
            // recording is active — the store guards on the recording flag.
            store.recordMacroInput(data);
          }
        });

        // Send resize events after fit — deduplicated to avoid SIGWINCH storms.
        // Multiple fit() calls from TerminalSlot (sync+RAF), ResizeObserver,
        // and the visibility effect can fire in rapid succession; only emit
        // resizeTerminal when the dimensions actually changed.
        const onResizeDisposable = xterm.onResize(({ cols, rows }) => {
          if (sessionIdRef.current && (cols !== lastSentCols || rows !== lastSentRows)) {
            lastSentCols = cols;
            lastSentRows = rows;
            frontendLog("terminal", `resize → PTY ${cols}×${rows} tab=${tabId}`);
            resizeTerminal(sessionIdRef.current, cols, rows);
          }
        });

        // Initial resize after connection.  The ResizeObserver may have
        // already fitted xterm to the correct dimensions while the async
        // createTerminal() was in-flight — but at that point sessionIdRef
        // was still null, so the resize was never sent to the backend PTY.
        // Send explicitly only when the current dims differ from what the
        // PTY was created with (or for workspace-restore where we don't
        // know the PTY's current state and must always sync).
        try {
          fitAddon.fit();
        } catch {
          // Container might not have dimensions yet
        }
        if (xterm.cols !== lastSentCols || xterm.rows !== lastSentRows) {
          lastSentCols = xterm.cols;
          lastSentRows = xterm.rows;
          frontendLog(
            "terminal",
            `resize (post-setup) → PTY ${xterm.cols}×${xterm.rows} tab=${tabId}`
          );
          resizeTerminal(sessionId, xterm.cols, xterm.rows);
        }

        // Send initial command after session connects (used by workspace launch)
        if (initialCommand && !initialSessionIdRef.current) {
          setTimeout(() => {
            sendInput(sessionId, initialCommand + "\n");
          }, 200);
        }

        cleanupRef.current = () => {
          unsubOutput();
          unsubExit();
          // Cancel pending RAF and flush remaining buffered output
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          flushOutput();
          // Drop any still-in-flight sandbox transforms for this session — the
          // tab is going away, so losing a few final transformed chunks is
          // acceptable and avoids awaiting the worker in a sync cleanup (#2136).
          discardSandboxSession(sessionId);
          onDataDisposable.dispose();
          onResizeDisposable.dispose();
          if (sessionIdRef.current) {
            // Session torn down while still live (tab closed/reconnecting) —
            // the exit handler never fired, so notify parsers here (#1998).
            sandboxNotifySessionEnd(sessionId);
            // Defer the close so that React StrictMode's rapid unmount→remount
            // can cancel it before the backend session is destroyed.
            const sid = sessionIdRef.current;
            sessionIdRef.current = null;
            if (persistentConnectionId) {
              // Detach from persistent session — backend process keeps running.
              pendingCloseTimerRef.current = setTimeout(() => {
                detachPersistentTab(sid, tabId).catch(() => {});
              }, 50);
            } else {
              pendingCloseTimerRef.current = setTimeout(() => {
                // Multi-window (#1900): if this session is being re-parented to
                // another window, the destination adopts it — do NOT close the
                // backend session. Consume the moving flag once.
                if (useAppStore.getState().isSessionMoving(sid)) {
                  useAppStore.getState().clearMovingSession(sid);
                  return;
                }
                closeTerminal(sid);
              }, 50);
            }
          }
        };
      } catch (err) {
        // Unexpected error outside the connection loop (e.g. subscription setup).
        const store = useAppStore.getState();
        store.setTerminalConnecting(tabId, false);
        store.setTerminalAutoRetrying(tabId, 0);
        store.setTerminalSpawnError(tabId, String(err));
      }
    },
    // initialSessionIdRef and initialCommand are intentionally excluded: they are
    // captured at mount time and must not trigger re-setup when the store writes
    // the session ID back after creation (which would blank the terminal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, tabId, getSessionId, registerSession, unregisterSession]
  );

  // Resolve the effective highlighting state for this terminal and apply it to
  // the engine. Folds the global config, the per-connection override, and the
  // runtime per-session toggle together; when the result is enabled the engine
  // compiles the active rules, otherwise it drops all decorations. Both
  // `enable` and `disable` are idempotent, so this is safe to call repeatedly.
  const applyHighlighting = useCallback(
    (engine: SyntaxHighlightingEngine) => {
      const state = useAppStore.getState();
      const resolved = resolveHighlightingConfig(
        currentSettingsView().syntaxHighlighting,
        state.tabTerminalOptions[tabId]?.syntaxHighlighting
      );
      const sessionId = sessionIdRef.current;
      // The per-session toggle (set by the status-bar quick action, #1704)
      // overrides the resolved on/off state for a single live session; a missing
      // entry means "follow the resolved config".
      const sessionOverride = sessionId ? state.sessionHighlighting[sessionId] : undefined;
      const enabled = sessionOverride ?? resolved.enabled;
      if (enabled) {
        engine.enable(resolveActiveRules(resolved));
      } else {
        engine.disable();
      }
    },
    [tabId]
  );

  // Create the terminal element, xterm instance, and register
  useEffect(() => {
    // Track whether this effect invocation is still active. In React StrictMode,
    // the effect runs twice (mount → unmount → mount). The canceled flag prevents
    // a stale async setupTerminal from overwriting the session created by the
    // second mount, which would send input to the wrong backend session.
    let canceled = false;

    // Unique connect id for THIS effect run's connect attempt. Keyed by the
    // retry generation so an overlapping retry/reconnect (which re-runs the
    // effect via the retryCount dep) gets a distinct id. The cleanup below
    // cancels only this id, so a stale cleanup can never abort a newer
    // attempt's in-flight handshake (#1125).
    const connectId = `${tabId}:${retryCount}`;

    // Capture the in-flight connect-id set for the cleanup below. The ref's
    // `.current` identity is stable for the tab's lifetime (it is never
    // reassigned, only mutated), so this local is the same Set the connect loop
    // adds/removes ids on — and reading it in cleanup avoids the
    // react-hooks/exhaustive-deps stale-ref warning.
    const inFlightConnects = connectInFlightRef.current;

    // Create an imperative DOM element for xterm (not managed by React rendering)
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.overflow = "hidden";
    // Expose which renderer is live for diagnostics (#2078). A renderer
    // regression shows up as a blank/garbled terminal, so surfacing whether the
    // GPU (webgl) or DOM path is active — in the DOM, readable in DevTools and by
    // the system-test bridge — makes "did WebGL init or fall back?" observable in
    // the field. Set to the final value once the addon is (or isn't) loaded below.
    el.dataset.terminalRenderer = "dom";
    el.setAttribute("data-testid", `terminal-renderer-${tabId}`);
    terminalElRef.current = el;

    // Inner viewport that hosts xterm. In horizontal-scroll mode this becomes the
    // horizontal scroll container, inset on the right by the gutter width (CSS), so
    // the reserved scrollbar gutter never overlaps content. xterm opens into this
    // element; FitAddon reads its width and so accounts for the gutter automatically.
    const scrollViewport = document.createElement("div");
    scrollViewport.className = "terminal-scroll-viewport";
    el.appendChild(scrollViewport);
    scrollViewportRef.current = scrollViewport;

    // Fixed gutter on the right that holds our own vertical scrollbar thumb. Hidden
    // unless horizontal-scroll mode is active (see the horizontal-scrolling effect).
    const gutter = document.createElement("div");
    gutter.className = "terminal-vscroll-gutter";
    const thumb = document.createElement("div");
    thumb.className = "terminal-vscroll-thumb";
    gutter.appendChild(thumb);
    el.appendChild(gutter);
    gutterRef.current = gutter;
    thumbRef.current = thumb;

    // Park the element so xterm.open() has a DOM parent
    parkingRef.current?.appendChild(el);

    const appSettings = currentSettingsView();
    const tabOpts = useAppStore.getState().tabTerminalOptions[tabId];
    const baseFontSize = tabOpts?.fontSize ?? appSettings.fontSize ?? DEFAULT_FONT_SIZE;
    const xterm = new XTerm({
      theme: getXtermTheme(),
      fontFamily: tabOpts?.fontFamily || appSettings.fontFamily || DEFAULT_FONT_FAMILY,
      fontSize: baseFontSize,
      lineHeight: tabOpts?.lineHeight ?? appSettings.lineHeight ?? DEFAULT_LINE_HEIGHT,
      scrollback: tabOpts?.scrollbackBuffer ?? appSettings.scrollbackBuffer ?? DEFAULT_SCROLLBACK,
      cursorBlink: tabOpts?.cursorBlink ?? appSettings.cursorBlink ?? DEFAULT_CURSOR_BLINK,
      cursorStyle: tabOpts?.cursorStyle ?? appSettings.cursorStyle ?? DEFAULT_CURSOR_STYLE,
      // Opt-in screen-reader mode (#2071): mirrors output into a live region for
      // assistive technology. Off by default (adds rendering overhead).
      screenReaderMode: appSettings.screenReaderMode ?? false,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    const unicode11Addon = new Unicode11Addon();
    xterm.loadAddon(unicode11Addon);
    xterm.unicode.activeVersion = "11";

    const searchAddon = new SearchAddon();
    xterm.loadAddon(searchAddon);
    registerSearchAddon(tabId, searchAddon);

    const serializeAddon = new SerializeAddon();
    xterm.loadAddon(serializeAddon);

    xterm.open(scrollViewport);

    // GPU-accelerated rendering (#2078). The WebGL addon replaces xterm's DOM
    // renderer with a WebGL2 canvas renderer — the single biggest render-
    // throughput win on high-volume output. It must be loaded AFTER open() so it
    // can attach to the already-created terminal DOM/dimensions.
    //
    // Every failure path degrades to the DOM renderer, never to a blank pane:
    //  - loadAddon() calls the addon's activate(), which creates the WebGL2
    //    context and throws if the WebView cannot provide one — caught here, the
    //    terminal simply keeps its DOM renderer.
    //  - onContextLoss fires if the GPU context is lost at runtime (driver reset,
    //    tab backgrounded, resource pressure). We dispose the addon, which makes
    //    xterm fall back to the DOM renderer automatically, so text keeps
    //    rendering. A one-shot fallback: we do not try to re-create the context.
    // The forced full-viewport refresh after each flush (see flushOutput) is a
    // DOM-renderer paint fix (#1849). It is skipped while WebGL is active
    // (#2107) — tracked via webglRendererActiveRef, which mirrors the renderer
    // state below — and resumes automatically on context-loss fallback so the
    // DOM path stays correct.
    let webglAddon: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        frontendLog("terminal", `webgl context lost tab=${tabId}; falling back to DOM renderer`);
        addon.dispose();
        webglAddon = null;
        webglRendererActiveRef.current = false;
        el.dataset.terminalRenderer = "dom";
      });
      xterm.loadAddon(addon);
      webglAddon = addon;
      webglRendererActiveRef.current = true;
      el.dataset.terminalRenderer = "webgl";
      frontendLog("terminal", `webgl renderer active tab=${tabId}`);
    } catch (err) {
      frontendLog(
        "terminal",
        `webgl renderer unavailable tab=${tabId}, using DOM renderer: ${String(err)}`
      );
      webglAddon?.dispose();
      webglAddon = null;
      webglRendererActiveRef.current = false;
      el.dataset.terminalRenderer = "dom";
    }

    // Instantiate the syntax-highlighting engine for this xterm and apply the
    // effective config. Created before the scrollback replay below so its
    // onWriteParsed hook (registered by `enable`) also scans replayed content.
    // The engine self-disables on the alternate screen and never recolors cells
    // whose foreground the server already set (see syntaxHighlighting.ts).
    const highlightEngine = new SyntaxHighlightingEngine(xterm);
    highlightEngineRef.current = highlightEngine;
    applyHighlighting(highlightEngine);

    // Replay the previous instance's scrollback captured on the last teardown
    // (a reconnect disposes the old xterm — see cleanup below). Writing it here,
    // before the new session connects, means a failed reconnect still shows the
    // prior scrollback under the disconnect overlay instead of a blank pane
    // (#1126). Persistent/agent tabs re-fetch or re-forward an authoritative
    // buffer from the server during reattach, so replaying the local snapshot too
    // would double the scrollback — skip it for those and rely on the server
    // buffer. `persistentConnectionId` covers persistent agent tabs (they fetch
    // via `getAgentSessionBuffer`); a backend-driven resilient agent reconnect
    // (#2476/#2512) has NO `persistentConnectionId` but likewise re-attaches to a
    // live agent session whose ring buffer the daemon re-forwards as live output
    // (`MSG_BUFFER_REPLAY`) — so it must skip the local replay too, otherwise the
    // recovered scrollback renders twice (compounding across reconnect attempts).
    // Always clear the ref so an unrelated re-run starts empty.
    if (scrollbackSnapshotRef.current) {
      const serverWillSupplyBuffer =
        !!persistentConnectionIdRef.current || isBackendDrivenAgentReconnectTabId(tabId);
      if (!serverWillSupplyBuffer) {
        xterm.write(scrollbackSnapshotRef.current);
      }
      scrollbackSnapshotRef.current = null;
    }

    // The terminal's vertical scrollbar lives in the gutter in every mode (xterm's
    // own overlay scrollbar is hidden via CSS), so it looks and behaves the same
    // whether or not horizontal scrolling is active.
    const scrollbar = createTerminalScrollbar({ xterm, gutter, thumb });
    scrollbarRef.current = scrollbar;

    // Intercept application shortcuts before xterm processes them
    xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      // In view mode the session is dead. Enter shows the reconnect prompt.
      if (e.key === "Enter" && !sessionIdRef.current && isViewModeRef.current) {
        useAppStore.getState().showTerminalReconnectPrompt(tabId);
        return false;
      }

      // Pass-through: keys reserved by the shell/tmux/vim/SSH-to-remote bypass
      // shortcut matching entirely so they reach the PTY untouched. Users can
      // turn this off in Settings → Keyboard Shortcuts.
      const passthroughEnabled = currentSettingsView().terminalKeyPassthrough !== false;
      if (passthroughEnabled && isShellReservedKey(e)) {
        return true;
      }

      // If a chord is pending, block the key from xterm
      if (isChordPending()) {
        return false;
      }

      const action = processKeyEvent(e);
      if (action === "chord-pending") {
        return false;
      }
      if (action === "copy") {
        copySelectionToClipboard(tabId);
        return false;
      }
      if (action === "paste") {
        // Prevent the browser's default Cmd+V / Ctrl+Shift+V action so
        // that no native paste event fires on xterm's internal textarea.
        // Without this, the clipboard text is sent twice: once by our
        // pasteToTerminal() and once by xterm's internal paste handler.
        e.preventDefault();
        pasteToTerminal(tabId);
        return false;
      }
      if (action === "select-all") {
        xterm.selectAll();
        return false;
      }

      // Block any other app shortcut from reaching xterm
      if (isAppShortcut(e)) {
        return false;
      }

      return true;
    });

    // Track CWD via OSC 7 (POSIX shells: zsh, bash, WSL, SSH).
    // Data is a file:// URI, e.g. "file:///home/user/foo" or "file:///C:/foo".
    const osc7Disposable = xterm.parser.registerOscHandler(7, (data: string) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") {
          let pathname = decodeURIComponent(url.pathname);
          // On Windows (e.g. WSL forwarding), paths arrive as /C:/foo —
          // strip the leading slash to get a valid Windows path.
          if (/^\/[A-Za-z]:\//.test(pathname)) {
            pathname = pathname.slice(1);
          }
          useAppStore.getState().setTabCwd(tabId, pathname);
        }
      } catch {
        // Ignore malformed OSC 7 data
      }
      return true;
    });

    // Track CWD via OSC 9;9 (Windows Terminal native: PowerShell, cmd.exe).
    // Data format after ident strip: "9;<raw-windows-path>", e.g. "9;C:\Users\foo".
    // No URL encoding or slash conversion — the path is used directly.
    const osc9Disposable = xterm.parser.registerOscHandler(9, (data: string) => {
      if (data.startsWith("9;")) {
        const path = data.slice(2);
        if (path) {
          useAppStore.getState().setTabCwd(tabId, path);
        }
      }
      return true;
    });

    // Track whether the user has scrolled away from the bottom.
    // Auto-scroll on new output is suppressed while the user is scrolled up.
    const onScrollDisposable = xterm.onScroll(() => {
      const buf = xterm.buffer.active;
      userScrolledUpRef.current = buf.viewportY < buf.baseY;
    });

    // Expose xterm instance on the DOM element for E2E test access
    (el as HTMLDivElement & { _xtermInstance?: XTerm })._xtermInstance = xterm;

    // Register element, xterm instance, and fit addon with the portal registry
    register(tabId, el, xterm, fitAddon);

    // Initial fit (may fail since element starts in parking)
    try {
      fitAddon.fit();
    } catch {
      // Container might not have dimensions yet
    }

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Wire to backend
    setupTerminal(xterm, fitAddon, () => canceled, connectId);

    // Re-fit once web fonts finish loading. The terminal font (Nerd Font
    // Mono) ships via @font-face with `font-display: swap`, so xterm's
    // initial cell-width measurement is taken against the fallback
    // monospace and FitAddon then computes one column fewer than the real
    // font would fit. Without this extra fit, the last column never
    // appears until the user manually resizes the window. Verified via
    // DOM measurement: FitAddon's stale 8.5 px fallback cell width
    // produced cols=112 at parent width 967, while the real Nerd Font at
    // 8.43 px / col yields cols=113 with no slider overlap.
    if (typeof document !== "undefined" && document.fonts) {
      void document.fonts
        .load(`${baseFontSize}px "MesloLGS Nerd Font Mono"`)
        .catch(() => undefined)
        .then(() => document.fonts.ready)
        .then(() => {
          if (canceled) return;
          try {
            fitAddon.fit();
          } catch {
            // Container not sized yet; the next ResizeObserver fit will catch it.
          }
        });
    }

    // Forward wheel events from the gap below the canvas to xterm.
    // FitAddon rounds rows down, so there is almost always a small gap
    // between the canvas bottom and the container edge.  The scrollable
    // element only covers the canvas area, so wheel events in the gap
    // would be lost.  We catch them on the container and scroll xterm.
    const handleGapWheel = (e: WheelEvent) => {
      const scrollable = el.querySelector(".xterm-scrollable-element");
      if (scrollable && !scrollable.contains(e.target as Node)) {
        const lines = Math.round(e.deltaY / 25);
        if (lines !== 0) {
          xterm.scrollLines(lines);
          e.preventDefault();
        }
      }
    };
    el.addEventListener("wheel", handleGapWheel, { passive: false });

    // ResizeObserver follows the element even when reparented.
    // When the terminal element moves from parking into the visible slot,
    // the observer fires and we re-fit xterm to the real container size.
    // After fitting, kick the SmoothScrollableElement so it recalculates
    // its viewport height — it may have cached stale dimensions from when
    // the element was in parking (hidden, zero-size).
    const resizeObserver = new ResizeObserver((entries) => {
      // Skip fit while the element is in the off-screen parking div (1×1 px).
      // Fitting at 1×1 would resize the PTY to ~2 cols × 1 row, causing the
      // backend shell to redraw at that width and fill the buffer with
      // line-wrapped garbage that persists after the element is re-adopted.
      const entry = entries[0];
      if (entry && (entry.contentRect.width < 10 || entry.contentRect.height < 10)) {
        frontendLog(
          "terminal",
          `ResizeObserver skipped fit (parking) tab=${tabId} rect=${entry.contentRect.width}×${entry.contentRect.height}`
        );
        return;
      }
      if (entry) {
        frontendLog(
          "terminal",
          `ResizeObserver fit tab=${tabId} rect=${entry.contentRect.width}×${entry.contentRect.height} xterm=${xterm.cols}×${xterm.rows}`
        );
      }
      try {
        if (horizontalScrollingRef.current) {
          // Only resize PTY when rows change (window/panel resize).
          // Also recalculate visual width for new container dimensions.
          const dims = fitAddon.proposeDimensions();
          if (dims && dims.rows !== xterm.rows) {
            xterm.resize(HORIZONTAL_SCROLL_COLS, dims.rows);
            updateHorizontalScrollWidth(xterm, fitAddon, el);
          }
        } else {
          fitAddon.fit();
        }
        // Force SmoothScrollableElement to refresh its layout after the
        // viewport dimensions change.  Without this, the first output
        // after terminal creation cannot be scrolled to the bottom.
        if (!userScrolledUpRef.current) {
          requestAnimationFrame(() => xterm.scrollToBottom());
        }
        // The gutter height tracks the container, so re-render the thumb.
        scrollbar.update();
      } catch {
        // Ignore fit errors during transitions
      }
    });
    resizeObserver.observe(el);

    return () => {
      canceled = true;
      // If the tab is torn down while a connect is in flight (e.g. the user hit
      // Cancel on the connecting overlay), abort the backend's handshake instead
      // of leaving it to run to completion (#952). Cancel only THIS effect run's
      // connect id — never the bare tabId — so an overlapping newer attempt is
      // not aborted by this stale cleanup (#1125).
      if (inFlightConnects.has(connectId)) {
        void cancelConnecting(connectId).catch(() => {});
      }
      resizeObserver.disconnect();
      el.removeEventListener("wheel", handleGapWheel);
      onScrollDisposable.dispose();
      osc7Disposable.dispose();
      osc9Disposable.dispose();
      unregister(tabId);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      scrollbar.dispose();
      scrollbarRef.current = null;
      // Snapshot the scrollback so the next effect run (a reconnect re-runs this
      // effect via the retryCount dep) can replay it into the fresh xterm. This
      // is what makes the disconnect overlay's "Scrollback is preserved below"
      // hold true even when the reconnect fails (#1126). Serialize before
      // dispose; guard so a serialize failure never blocks teardown.
      try {
        const snapshot = serializeAddon.serialize();
        scrollbackSnapshotRef.current = snapshot.length > 0 ? snapshot : null;
      } catch (err) {
        frontendLog("terminal", `Failed to snapshot scrollback tab=${tabId}: ${String(err)}`);
        scrollbackSnapshotRef.current = null;
      }
      // Dispose the highlighting engine on the same boundary as the xterm
      // instance so no decorations or write hooks leak past teardown.
      highlightEngine.dispose();
      highlightEngineRef.current = null;
      // Dispose the WebGL renderer explicitly before the terminal so its GPU
      // context/canvas is released deterministically (#2078). Null after a
      // context-loss fallback, in which case it is already disposed.
      webglAddon?.dispose();
      webglAddon = null;
      // Reset the renderer flag so a reconnect starts on the DOM-safe path
      // (refresh enabled) until the new xterm re-activates WebGL (#2107).
      webglRendererActiveRef.current = false;
      xterm.dispose();
      el.remove();
      terminalElRef.current = null;
      scrollViewportRef.current = null;
      gutterRef.current = null;
      thumbRef.current = null;
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    tabId,
    setupTerminal,
    register,
    unregister,
    copySelectionToClipboard,
    pasteToTerminal,
    registerSearchAddon,
    parkingRef,
    retryCount,
    applyHighlighting,
  ]);

  // Re-fit and focus when visibility changes
  useEffect(() => {
    if (isVisible && fitAddonRef.current && xtermRef.current && terminalElRef.current) {
      try {
        if (horizontalScrollingRef.current) {
          applyHorizontalScrollResize(xtermRef.current, fitAddonRef.current, terminalElRef.current);
        } else {
          fitAddonRef.current.fit();
        }
      } catch {
        // Ignore
      }
      xtermRef.current.focus();
    }
  }, [isVisible]);

  // React to horizontal scrolling state changes
  const horizontalScrolling = useAppStore((s) => s.tabHorizontalScrolling[tabId] ?? false);

  useEffect(() => {
    horizontalScrollingRef.current = horizontalScrolling;
    const el = terminalElRef.current;
    const scrollViewport = scrollViewportRef.current;
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !scrollViewport || !xterm || !fitAddon) return;

    if (horizontalScrolling) {
      // The viewport (not el) becomes the horizontal scroll container and is
      // inset on the right (CSS) to reserve the gutter the vertical scrollbar
      // already occupies in normal mode.
      scrollViewport.classList.add("terminal-horizontal-scroll");
      try {
        applyHorizontalScrollResize(xterm, fitAddon, el);
      } catch {
        // Ignore resize errors
      }
      scrollbarRef.current?.update();

      // Mark content dirty when new output arrives
      const writeParsedDisposable = xterm.onWriteParsed(() => {
        contentDirtyRef.current = true;
      });

      // Periodically update scroll width when keyboard is idle
      const KEYBOARD_IDLE_MS = 800;
      const CHECK_INTERVAL_MS = 500;
      const intervalId = setInterval(() => {
        if (contentDirtyRef.current && Date.now() - lastInputTimeRef.current >= KEYBOARD_IDLE_MS) {
          contentDirtyRef.current = false;
          try {
            updateHorizontalScrollWidth(xterm, fitAddon, el);
          } catch {
            // Ignore errors during transitions
          }
        }
      }, CHECK_INTERVAL_MS);

      return () => {
        writeParsedDisposable.dispose();
        clearInterval(intervalId);
        contentDirtyRef.current = false;
      };
    } else {
      scrollViewport.classList.remove("terminal-horizontal-scroll");
      try {
        removeHorizontalScrollResize(xterm, fitAddon);
      } catch {
        // Ignore fit errors
      }
      scrollbarRef.current?.update();
    }
  }, [horizontalScrolling, tabId]);

  // React to settings changes on live terminals (per-tab overrides take precedence)
  const projectedSettings = useProjectedSettings();
  const theme = projectedSettings.theme;
  const fontFamily = projectedSettings.fontFamily;
  const fontSize = projectedSettings.fontSize;
  const cursorBlink = projectedSettings.cursorBlink;
  const cursorStyle = projectedSettings.cursorStyle;
  const scrollbackBuffer = projectedSettings.scrollbackBuffer;
  const screenReaderMode = projectedSettings.screenReaderMode;
  const tabTermOpts = useAppStore((s) => s.tabTerminalOptions[tabId]);

  useEffect(() => {
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!xterm) return;

    xterm.options.theme = getXtermTheme();
    xterm.options.fontFamily = tabTermOpts?.fontFamily || fontFamily || DEFAULT_FONT_FAMILY;
    xterm.options.fontSize = tabTermOpts?.fontSize ?? fontSize ?? DEFAULT_FONT_SIZE;
    xterm.options.cursorBlink = tabTermOpts?.cursorBlink ?? cursorBlink ?? DEFAULT_CURSOR_BLINK;
    xterm.options.cursorStyle = tabTermOpts?.cursorStyle ?? cursorStyle ?? DEFAULT_CURSOR_STYLE;
    xterm.options.scrollback =
      tabTermOpts?.scrollbackBuffer ?? scrollbackBuffer ?? DEFAULT_SCROLLBACK;
    xterm.options.screenReaderMode = screenReaderMode ?? false;

    // Re-fit after font changes
    if (fitAddon) {
      try {
        if (!horizontalScrollingRef.current) {
          fitAddon.fit();
        }
      } catch {
        // Ignore fit errors
      }
    }
  }, [
    theme,
    fontFamily,
    fontSize,
    cursorBlink,
    cursorStyle,
    scrollbackBuffer,
    screenReaderMode,
    tabTermOpts,
    tabId,
  ]);

  // Re-apply highlighting when the global config, the per-connection override, or
  // the per-session toggle changes on a live terminal. `applyHighlighting`
  // resolves all three from the store, so re-running it on any of these keeps the
  // engine in sync — including toggling it off live, which drops all decorations.
  const globalHighlighting = projectedSettings.syntaxHighlighting;
  const sessionHighlightingOverride = useAppStore((s) =>
    existingSessionId ? s.sessionHighlighting[existingSessionId] : undefined
  );

  useEffect(() => {
    const engine = highlightEngineRef.current;
    if (!engine) return;
    applyHighlighting(engine);
  }, [
    applyHighlighting,
    globalHighlighting,
    tabTermOpts,
    sessionHighlightingOverride,
    existingSessionId,
  ]);

  // Keep the backend's per-session line ending in sync when the global default
  // or this connection's override changes while the terminal is open.
  const defaultLineEnding = projectedSettings.defaultLineEnding;
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) void pushLineEnding(tabId, sessionId);
  }, [tabTermOpts, defaultLineEnding, tabId]);

  // Terminal renders nothing — TerminalSlot handles display
  return null;
}
