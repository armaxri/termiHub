import { useEffect, useRef, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";
import { ConnectionConfig } from "@/types/terminal";
import { createTerminal, sendInput, resizeTerminal, closeTerminal } from "@/services/api";
import { terminalDispatcher } from "@/services/events";
import { useTerminalRegistry } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { getXtermTheme } from "@/themes";
import { processKeyEvent, isAppShortcut, isChordPending } from "@/services/keybindings";
import { frontendLog } from "@/utils/frontendLog";

const HORIZONTAL_SCROLL_COLS = 500;

const DEFAULT_FONT_FAMILY =
  "'MesloLGS Nerd Font Mono', 'MesloLGS NF', 'CaskaydiaCove Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";
const DEFAULT_FONT_SIZE = 14;
/** Line height of 1.0 ensures box-drawing characters connect without gaps. */
export const DEFAULT_LINE_HEIGHT = 1.0;
const DEFAULT_SCROLLBACK = 5000;
const DEFAULT_CURSOR_STYLE = "block" as const;
const DEFAULT_CURSOR_BLINK = true;

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
function updateHorizontalScrollWidth(xterm: XTerm, fitAddon: FitAddon, container: HTMLElement) {
  const dims = fitAddon.proposeDimensions();
  if (!dims || dims.cols <= 0) return;

  const cellWidth = container.clientWidth / dims.cols;
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

interface TerminalProps {
  tabId: string;
  config: ConnectionConfig;
  isVisible: boolean;
  existingSessionId?: string | null;
  /** Optional command to send after the session connects. */
  initialCommand?: string;
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
}: TerminalProps) {
  const retryCount = useAppStore((s) => s.terminalRetryCounters[tabId] ?? 0);
  const terminalElRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const horizontalScrollingRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const lastInputTimeRef = useRef(0);
  const contentDirtyRef = useRef(false);
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
  const {
    register,
    unregister,
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
    async (xterm: XTerm, fitAddon: FitAddon, isCanceled: () => boolean) => {
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
        if (initialSessionIdRef.current) {
          sessionId = initialSessionIdRef.current;
          // Workspace-restore: PTY dims unknown — leave ptyCols/ptyRows at 0
          // so the post-setup resize always fires to re-sync xterm with the PTY.
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
              resolved = await createTerminal(sessionConfig);

              if (isCanceled()) {
                closeTerminal(resolved);
                return;
              }
              // Success — clear all pre-connect overlay state.
              useAppStore.getState().setTerminalConnecting(tabId, false);
              useAppStore.getState().setTerminalAutoRetrying(tabId, 0);
              useAppStore.getState().setTerminalSpawnError(tabId, null);
              break;
            } catch (err) {
              if (isCanceled()) return;
              useAppStore.getState().setTerminalConnecting(tabId, false);

              if (isAgentSession && agentId) {
                // Check whether the agent transport itself is still connecting.
                const agentState = useAppStore
                  .getState()
                  .remoteAgents.find((a) => a.id === agentId)?.connectionState;

                if (agentState === "connecting" || agentState === "reconnecting") {
                  // Park tab; TerminalView wakes it via retryTerminalSpawn
                  // once the agent emits "connected".
                  useAppStore.getState().setTerminalWaitingForAgent(tabId, agentId);
                  return;
                }

                // Agent is up but the session creation failed.
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

                attempt++;
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

        // Output batching: buffer chunks and flush in a single RAF callback
        const outputBuffer: Uint8Array[] = [];
        let rafId: number | null = null;

        const flushOutput = () => {
          rafId = null;
          if (outputBuffer.length === 0) return;

          // xterm.js 6's SmoothScrollableElement updates its scroll range
          // during the render pass (requestAnimationFrame), which runs
          // AFTER the write callback.  Calling scrollToBottom() in the
          // write callback is too early — the scroll range still reflects
          // the old content height.  Defer to a RAF so the render pass
          // completes first and scrollToBottom() targets the correct
          // position.
          const scrollAfterWrite = () => {
            if (!userScrolledUpRef.current) {
              requestAnimationFrame(() => xterm.scrollToBottom());
            }
          };

          if (outputBuffer.length === 1) {
            xterm.write(outputBuffer[0], scrollAfterWrite);
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
            xterm.write(merged, scrollAfterWrite);
          }
          outputBuffer.length = 0;
        };

        // Subscribe to output events via singleton dispatcher (O(1) routing)
        const unsubOutput = terminalDispatcher.subscribeOutput(sessionId, (data) => {
          outputBuffer.push(data);
          if (rafId === null) {
            rafId = requestAnimationFrame(flushOutput);
          }
        });

        // Subscribe to exit events via singleton dispatcher
        frontendLog("disconnect", `subscribed exit for session=${sessionId} tab=${tabId}`);
        const unsubExit = terminalDispatcher.subscribeExit(sessionId, () => {
          frontendLog("disconnect", `terminal-exit fired session=${sessionId} tab=${tabId}`);
          xterm.writeln("\r\n\x1b[90m[Process exited]\x1b[0m");
          sessionIdRef.current = null;
          unregisterSession(tabId);
          useAppStore.getState().setTerminalExited(tabId);
        });

        // Send user input to backend
        const onDataDisposable = xterm.onData((data) => {
          lastInputTimeRef.current = Date.now();
          if (sessionIdRef.current) {
            sendInput(sessionIdRef.current, data);
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
          onDataDisposable.dispose();
          onResizeDisposable.dispose();
          if (sessionIdRef.current) {
            // Defer the close so that React StrictMode's rapid unmount→remount
            // can cancel it before the backend session is destroyed.
            const sid = sessionIdRef.current;
            sessionIdRef.current = null;
            pendingCloseTimerRef.current = setTimeout(() => {
              closeTerminal(sid);
            }, 50);
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
    [config, tabId, registerSession, unregisterSession]
  );

  // Create the terminal element, xterm instance, and register
  useEffect(() => {
    // Track whether this effect invocation is still active. In React StrictMode,
    // the effect runs twice (mount → unmount → mount). The canceled flag prevents
    // a stale async setupTerminal from overwriting the session created by the
    // second mount, which would send input to the wrong backend session.
    let canceled = false;

    // Create an imperative DOM element for xterm (not managed by React rendering)
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    terminalElRef.current = el;

    // Park the element so xterm.open() has a DOM parent
    parkingRef.current?.appendChild(el);

    const appSettings = useAppStore.getState().settings;
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

    xterm.open(el);

    // Intercept application shortcuts before xterm processes them
    xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;

      // In view mode the session is dead. Enter shows the reconnect prompt.
      if (e.key === "Enter" && !sessionIdRef.current && isViewModeRef.current) {
        useAppStore.getState().showTerminalReconnectPrompt(tabId);
        return false;
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
    setupTerminal(xterm, fitAddon, () => canceled);

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
      } catch {
        // Ignore fit errors during transitions
      }
    });
    resizeObserver.observe(el);

    return () => {
      canceled = true;
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
      xterm.dispose();
      el.remove();
      terminalElRef.current = null;
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
    const xterm = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !xterm || !fitAddon) return;

    if (horizontalScrolling) {
      el.classList.add("terminal-horizontal-scroll");
      try {
        applyHorizontalScrollResize(xterm, fitAddon, el);
      } catch {
        // Ignore resize errors
      }

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
      el.classList.remove("terminal-horizontal-scroll");
      try {
        removeHorizontalScrollResize(xterm, fitAddon);
      } catch {
        // Ignore fit errors
      }
    }
  }, [horizontalScrolling, tabId]);

  // React to settings changes on live terminals (per-tab overrides take precedence)
  const theme = useAppStore((s) => s.settings.theme);
  const fontFamily = useAppStore((s) => s.settings.fontFamily);
  const fontSize = useAppStore((s) => s.settings.fontSize);
  const cursorBlink = useAppStore((s) => s.settings.cursorBlink);
  const cursorStyle = useAppStore((s) => s.settings.cursorStyle);
  const scrollbackBuffer = useAppStore((s) => s.settings.scrollbackBuffer);
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
  }, [theme, fontFamily, fontSize, cursorBlink, cursorStyle, scrollbackBuffer, tabTermOpts, tabId]);

  // Terminal renders nothing — TerminalSlot handles display
  return null;
}
