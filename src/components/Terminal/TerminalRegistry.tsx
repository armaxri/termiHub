import {
  createContext,
  useContext,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  ReactNode,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import { sendInput } from "@/services/api";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { SessionId } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { currentBroadcastView } from "@/store/broadcastBridge";
import { currentSettingsView } from "@/store/settingsBridge";
import { frontendLog } from "@/utils/frontendLog";
import { bufferToLogicalLines } from "@/utils/terminalBuffer";

const LARGE_PASTE_THRESHOLD = 5000;

/**
 * Minimum spacing between two paste triggers for the *same* terminal tab. A
 * duplicated/bounced OS mouse signal (seen on Windows right-click, #2595) fires
 * the paste action more than once for a single gesture, inserting the clipboard
 * content twice. Any second trigger for a tab within this window is dropped.
 *
 * 50 ms is short enough that no human deliberately pastes into the same terminal
 * twice that fast (a bounced signal arrives within a few ms), yet long enough to
 * swallow the duplicate. The guard is default-on and keyed per tab, so pasting
 * into two different tabs in quick succession is unaffected.
 */
export const PASTE_DEBOUNCE_MS = 50;

interface TerminalRegistryContextType {
  /** Register a terminal's xterm container element, xterm instance, and fit addon. */
  register: (tabId: string, element: HTMLDivElement, xterm: XTerm, fitAddon: FitAddon) => void;
  /** Unregister a terminal element (on terminal close). */
  unregister: (tabId: string) => void;
  /** Get the registered element for a tab. */
  getElement: (tabId: string) => HTMLDivElement | undefined;
  /** Focus the xterm instance for a tab so it receives keyboard input. */
  focusTerminal: (tabId: string) => void;
  /** Clear the terminal scrollback and screen for a tab. */
  clearTerminal: (tabId: string) => void;
  /**
   * Read a terminal's reconstructed logical-line text, or `undefined` when no
   * terminal is registered for the tab. Used by the in-app test bridge to assert
   * on displayed terminal output without scraping the GPU canvas.
   */
  getTerminalContent: (tabId: string, joinFullWidthRows?: boolean) => string | undefined;
  /**
   * Scroll a terminal's viewport by `lines` logical lines (negative = up into
   * scrollback), or jump to the bottom when `toBottom` is true. Routes through
   * xterm's own scroll so the same `onScroll` event a wheel gesture fires also
   * fires here (the auto-scroll guard keys off it). Returns `true` when a
   * terminal was registered for the tab, `false` otherwise. Used by the test
   * bridge to exercise auto-scroll without synthesizing canvas wheel events.
   */
  scrollTerminal: (tabId: string, lines: number, toBottom?: boolean) => boolean;
  /**
   * Read a terminal's viewport scroll position as `{ viewportY, baseY }`, or
   * `undefined` when no terminal is registered for the tab. `viewportY < baseY`
   * means scrolled up into scrollback; equal means pinned to the bottom. Used by
   * the test bridge to assert auto-scroll behavior without scraping the canvas.
   */
  getTerminalViewport: (tabId: string) => { viewportY: number; baseY: number } | undefined;
  /** Save terminal buffer content to a file via native save dialog. */
  saveTerminalToFile: (tabId: string) => Promise<void>;
  /** Copy terminal buffer content to the clipboard. */
  copyTerminalToClipboard: (tabId: string) => Promise<void>;
  /** Open the terminal buffer content in a new unsaved (scratch) editor tab. */
  openTerminalInEditor: (tabId: string, tabTitle: string) => void;
  /** Get the current text selection in a terminal, or undefined if none. */
  getTerminalSelection: (tabId: string) => string | undefined;
  /** Clear the current text selection in a terminal. */
  clearTerminalSelection: (tabId: string) => void;
  /** Copy the current text selection to the clipboard (no-op if nothing selected). */
  copySelectionToClipboard: (tabId: string) => Promise<void>;
  /**
   * Resolve a tab's live backend session ID, or `undefined` when no session is
   * registered for the tab. Stable accessor over the internal `tabId → sessionId`
   * map; used by the broadcast-input fan-out (#1955) to dispatch typed input to
   * every target session.
   */
  getSessionId: (tabId: string) => SessionId | undefined;
  /** Associate a backend session ID with a tab for paste support. */
  registerSession: (tabId: string, sessionId: SessionId) => void;
  /** Remove the session ID association for a tab. */
  unregisterSession: (tabId: string) => void;
  /** Paste clipboard text into a terminal by sending it as input. */
  pasteToTerminal: (tabId: string) => Promise<void>;
  /**
   * Write `data` into the backend session bound to `tabId`, returning `true` when
   * a session was found and the input was sent, or `false` when no session is
   * registered for the tab. Used by the in-app test bridge to drive a shell;
   * routes through the same `send_input` choke point as interactive typing, so
   * line-ending normalization applies.
   */
  sendInputToTerminal: (tabId: string, data: string) => Promise<boolean>;
  /** Register a search addon for a terminal tab. */
  registerSearchAddon: (tabId: string, addon: SearchAddon) => void;
  /** Search forward in the terminal. */
  findNext: (tabId: string, query: string, options?: ISearchOptions) => boolean;
  /** Search backward in the terminal. */
  findPrevious: (tabId: string, query: string, options?: ISearchOptions) => boolean;
  /** Clear search decorations in the terminal. */
  clearSearchDecorations: (tabId: string) => void;
  /** Fit the terminal to its current container dimensions. */
  fitTerminal: (tabId: string) => void;
  /** Ref to the off-screen parking div for orphaned terminal elements. */
  parkingRef: React.RefObject<HTMLDivElement | null>;
}

const TerminalRegistryContext = createContext<TerminalRegistryContextType | null>(null);

export function useTerminalRegistry() {
  const ctx = useContext(TerminalRegistryContext);
  if (!ctx) throw new Error("useTerminalRegistry must be used within TerminalPortalProvider");
  return ctx;
}

/**
 * Provides a registry for terminal DOM elements and an off-screen parking area.
 * Terminal components register their xterm container elements here.
 * TerminalSlot components adopt these elements into panel slots via DOM reparenting.
 */
export function TerminalPortalProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef(new Map<string, HTMLDivElement>());
  const xtermRegistryRef = useRef(new Map<string, XTerm>());
  const fitAddonRegistryRef = useRef(new Map<string, FitAddon>());
  const sessionRegistryRef = useRef(new Map<string, SessionId>());
  const searchAddonRegistryRef = useRef(new Map<string, SearchAddon>());
  // Per-tab timestamp of the last accepted paste, used to drop a bounced/duplicated
  // paste trigger for the same tab within PASTE_DEBOUNCE_MS (#2595).
  const lastPasteAtRef = useRef(new Map<string, number>());
  const parkingRef = useRef<HTMLDivElement | null>(null);

  const register = useCallback(
    (tabId: string, element: HTMLDivElement, xterm: XTerm, fitAddon: FitAddon) => {
      registryRef.current.set(tabId, element);
      xtermRegistryRef.current.set(tabId, xterm);
      fitAddonRegistryRef.current.set(tabId, fitAddon);
    },
    []
  );

  const unregister = useCallback((tabId: string) => {
    registryRef.current.delete(tabId);
    xtermRegistryRef.current.delete(tabId);
    fitAddonRegistryRef.current.delete(tabId);
    sessionRegistryRef.current.delete(tabId);
    searchAddonRegistryRef.current.delete(tabId);
    lastPasteAtRef.current.delete(tabId);
  }, []);

  const getElement = useCallback((tabId: string) => {
    return registryRef.current.get(tabId);
  }, []);

  const focusTerminal = useCallback((tabId: string) => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (xterm) {
      xterm.focus();
    }
  }, []);

  const fitTerminal = useCallback((tabId: string) => {
    const fitAddon = fitAddonRegistryRef.current.get(tabId);
    const xterm = xtermRegistryRef.current.get(tabId);
    if (!fitAddon) return;
    const el = registryRef.current.get(tabId);
    const w = el?.offsetWidth ?? -1;
    const h = el?.offsetHeight ?? -1;
    frontendLog(
      "terminal_registry",
      `fitTerminal tab=${tabId} el=${w}×${h} xterm=${xterm?.cols}×${xterm?.rows}`
    );
    try {
      fitAddon.fit();
      frontendLog(
        "terminal_registry",
        `fitTerminal after fit tab=${tabId} xterm=${xterm?.cols}×${xterm?.rows}`
      );
    } catch (err) {
      frontendLog("terminal_registry", `fitTerminal fit error tab=${tabId}: ${err}`);
    }
    if (xterm) {
      requestAnimationFrame(() => {
        xterm.scrollToBottom();
        // Force a full repaint of the viewport. fitAddon.fit() only re-renders
        // when the computed cols/rows actually change; when a terminal is
        // reparented into a same-size container — e.g. zooming a tab into the
        // overlay — fit() is a no-op, so the renderer keeps showing stale/blank
        // rows until a scroll event marks them dirty. That is why zoomed content
        // only appeared after scrolling up/down. Refreshing every visible row
        // makes the repaint deterministic so content shows immediately (#1823).
        xterm.refresh(0, Math.max(0, xterm.rows - 1));
      });
    }
  }, []);

  const clearTerminal = useCallback((tabId: string) => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (xterm) {
      // \x1b[2J erases the entire viewport including the current line.  Without
      // this, xterm.js v6's clear() preserves the cursor line as the "new first
      // line", leaving the shell prompt visible as a ghost element.
      // \x1b[H moves the cursor to (0,0) so subsequent output starts at the top.
      // xterm.clear() is called in the write callback so the VT erase is fully
      // processed before the scrollback is purged.
      xterm.write("\x1b[2J\x1b[H", () => {
        xterm.clear();
        requestAnimationFrame(() => xterm.scrollToBottom());
      });
    }
  }, []);

  const getTerminalContent = useCallback(
    (tabId: string, joinFullWidthRows = false): string | undefined => {
      const xterm = xtermRegistryRef.current.get(tabId);
      if (!xterm) return undefined;
      return bufferToLogicalLines(xterm.buffer.active, xterm.cols, joinFullWidthRows);
    },
    []
  );

  const scrollTerminal = useCallback((tabId: string, lines: number, toBottom = false): boolean => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (!xterm) return false;
    if (toBottom) {
      xterm.scrollToBottom();
    } else {
      xterm.scrollLines(lines);
    }
    return true;
  }, []);

  const getTerminalViewport = useCallback(
    (tabId: string): { viewportY: number; baseY: number } | undefined => {
      const xterm = xtermRegistryRef.current.get(tabId);
      if (!xterm) return undefined;
      const buf = xterm.buffer.active;
      return { viewportY: buf.viewportY, baseY: buf.baseY };
    },
    []
  );

  const saveTerminalToFile = useCallback(
    async (tabId: string) => {
      // Saved files should reflect logical lines, so rejoin hard wraps at the
      // terminal width in addition to xterm's own soft wraps.
      const content = getTerminalContent(tabId, true);
      if (!content) return;

      const filePath = await save({
        title: "Save terminal content",
        defaultPath: "terminal-output.txt",
      });
      if (!filePath) return;

      await writeTextFile(filePath, content);

      // Offer to open the just-saved file in an editor tab, unless the user
      // disabled the prompt (in which case the file is saved silently).
      const { showOpenSavedFileDialog } = useAppStore.getState();
      if (currentSettingsView().askOpenSavedFileInTab ?? true) {
        showOpenSavedFileDialog(filePath);
      }
    },
    [getTerminalContent]
  );

  const copyTerminalToClipboard = useCallback(
    async (tabId: string) => {
      const content = getTerminalContent(tabId);
      if (!content) return;

      // Use the Tauri clipboard plugin (like paste) rather than the web
      // clipboard API: navigator.clipboard.writeText rejects on macOS/WKWebView
      // when the document isn't focused, silently dropping the copy.
      await writeClipboard(content);
    },
    [getTerminalContent]
  );

  const openTerminalInEditor = useCallback(
    (tabId: string, tabTitle: string) => {
      // Capture logical lines (rejoin hard wraps), matching "Save to File".
      const content = getTerminalContent(tabId, true);
      if (!content) return;

      const base = (tabTitle || "terminal")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const fileName = `${base || "terminal"}.txt`;
      const title = `${tabTitle || "Terminal"} (output)`;
      useAppStore.getState().openScratchEditorTab(title, fileName, content);
    },
    [getTerminalContent]
  );

  const getTerminalSelection = useCallback((tabId: string): string | undefined => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (!xterm || !xterm.hasSelection()) return undefined;
    return xterm.getSelection();
  }, []);

  const clearTerminalSelection = useCallback((tabId: string) => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (xterm) xterm.clearSelection();
  }, []);

  const copySelectionToClipboard = useCallback(
    async (tabId: string) => {
      const selection = getTerminalSelection(tabId);
      if (!selection) return;

      // See copyTerminalToClipboard: route through the OS clipboard so the copy
      // lands even when the window isn't focused (web clipboard rejects there).
      await writeClipboard(selection);
    },
    [getTerminalSelection]
  );

  const getSessionId = useCallback((tabId: string): SessionId | undefined => {
    return sessionRegistryRef.current.get(tabId);
  }, []);

  const registerSession = useCallback((tabId: string, sessionId: SessionId) => {
    sessionRegistryRef.current.set(tabId, sessionId);
    useAppStore.getState().setTabSessionId(tabId, sessionId);
  }, []);

  const unregisterSession = useCallback((tabId: string) => {
    sessionRegistryRef.current.delete(tabId);
    useAppStore.getState().setTabSessionId(tabId, null);
  }, []);

  const pasteToTerminal = useCallback(
    async (tabId: string) => {
      const sessionId = sessionRegistryRef.current.get(tabId);
      if (!sessionId) return;

      // Drop a bounced/duplicated paste trigger: on Windows a single right-click
      // can deliver the paste signal twice a few ms apart, pasting the clipboard
      // content twice. Ignore a second trigger for the same tab within the guard
      // window; keyed per tab so quick pastes into different tabs both apply
      // (#2595). All paste paths (right-click quick action, context-menu Paste,
      // Cmd/Ctrl+V) funnel through here, so guarding here covers every trigger.
      const now = Date.now();
      const lastPasteAt = lastPasteAtRef.current.get(tabId);
      if (lastPasteAt !== undefined && now - lastPasteAt < PASTE_DEBOUNCE_MS) return;
      lastPasteAtRef.current.set(tabId, now);

      const text = await readClipboard();
      if (!text) return;

      const doPaste = async () => {
        // Bracket the payload per-terminal — bracketed-paste mode is a per-terminal
        // protocol state; line-ending normalization happens in the backend
        // send_input choke point, so paste only handles bracketing here.
        const pasteInto = (targetTabId: string, targetSessionId: SessionId) => {
          const xterm = xtermRegistryRef.current.get(targetTabId);
          const payload =
            xterm && xterm.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
          return sendInput(targetSessionId, payload);
        };

        // Broadcast fan-out (#1981): when this tab is the active broadcast source,
        // paste into every connected target — matching the onData fan-out and the
        // context-menu paste path — not just the source session.
        const store = useAppStore.getState();
        const bcView = currentBroadcastView();
        if (bcView.active && bcView.sourceTabId === tabId) {
          await Promise.all(
            store.getBroadcastTargetTabIds().flatMap((targetTabId) => {
              const targetSessionId = getSessionId(targetTabId);
              return targetSessionId ? [pasteInto(targetTabId, targetSessionId)] : [];
            })
          );
          return;
        }

        await pasteInto(tabId, sessionId);
      };

      if (text.length > LARGE_PASTE_THRESHOLD) {
        useAppStore.getState().showLargePasteDialog(text.length, doPaste);
      } else {
        await doPaste();
      }
    },
    [getSessionId]
  );

  const sendInputToTerminal = useCallback(async (tabId: string, data: string): Promise<boolean> => {
    const sessionId = sessionRegistryRef.current.get(tabId);
    if (!sessionId) return false;
    await sendInput(sessionId, data);
    return true;
  }, []);

  // Expose the terminal-input seam to the macro playback service (#1675) so the
  // store's `playMacro` can inject through the same `send_input` choke point as
  // interactive typing, without holding a React ref. Cleared on unmount.
  useEffect(() => {
    registerTerminalInputInjector(sendInputToTerminal);
    return () => registerTerminalInputInjector(null);
  }, [sendInputToTerminal]);

  const registerSearchAddon = useCallback((tabId: string, addon: SearchAddon) => {
    searchAddonRegistryRef.current.set(tabId, addon);
  }, []);

  const findNext = useCallback(
    (tabId: string, query: string, options?: ISearchOptions): boolean => {
      const addon = searchAddonRegistryRef.current.get(tabId);
      if (!addon || !query) return false;
      return addon.findNext(query, options);
    },
    []
  );

  const findPrevious = useCallback(
    (tabId: string, query: string, options?: ISearchOptions): boolean => {
      const addon = searchAddonRegistryRef.current.get(tabId);
      if (!addon || !query) return false;
      return addon.findPrevious(query, options);
    },
    []
  );

  const clearSearchDecorations = useCallback((tabId: string) => {
    const addon = searchAddonRegistryRef.current.get(tabId);
    if (addon) addon.clearDecorations();
  }, []);

  const ctx = useMemo(
    () => ({
      register,
      unregister,
      getElement,
      focusTerminal,
      fitTerminal,
      clearTerminal,
      getTerminalContent,
      scrollTerminal,
      getTerminalViewport,
      saveTerminalToFile,
      copyTerminalToClipboard,
      openTerminalInEditor,
      getTerminalSelection,
      clearTerminalSelection,
      copySelectionToClipboard,
      getSessionId,
      registerSession,
      unregisterSession,
      pasteToTerminal,
      sendInputToTerminal,
      registerSearchAddon,
      findNext,
      findPrevious,
      clearSearchDecorations,
      parkingRef,
    }),
    [
      register,
      unregister,
      getElement,
      focusTerminal,
      fitTerminal,
      clearTerminal,
      getTerminalContent,
      scrollTerminal,
      getTerminalViewport,
      saveTerminalToFile,
      copyTerminalToClipboard,
      openTerminalInEditor,
      getTerminalSelection,
      clearTerminalSelection,
      copySelectionToClipboard,
      getSessionId,
      registerSession,
      unregisterSession,
      pasteToTerminal,
      sendInputToTerminal,
      registerSearchAddon,
      findNext,
      findPrevious,
      clearSearchDecorations,
    ]
  );

  return (
    <TerminalRegistryContext.Provider value={ctx}>
      {children}
      <div
        ref={parkingRef}
        style={{
          position: "fixed",
          left: "-10000px",
          top: "-10000px",
          width: "1px",
          height: "1px",
          overflow: "hidden",
          pointerEvents: "none",
        }}
      />
    </TerminalRegistryContext.Provider>
  );
}
