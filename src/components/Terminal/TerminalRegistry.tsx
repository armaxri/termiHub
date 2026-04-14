import { createContext, useContext, useRef, useCallback, useMemo, ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { readText as readClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { sendInput } from "@/services/api";
import { SessionId } from "@/types/terminal";
import { useAppStore } from "@/store/appStore";
import { frontendLog } from "@/utils/frontendLog";

const LARGE_PASTE_THRESHOLD = 5000;

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
  /** Save terminal buffer content to a file via native save dialog. */
  saveTerminalToFile: (tabId: string) => Promise<void>;
  /** Copy terminal buffer content to the clipboard. */
  copyTerminalToClipboard: (tabId: string) => Promise<void>;
  /** Get the current text selection in a terminal, or undefined if none. */
  getTerminalSelection: (tabId: string) => string | undefined;
  /** Clear the current text selection in a terminal. */
  clearTerminalSelection: (tabId: string) => void;
  /** Copy the current text selection to the clipboard (no-op if nothing selected). */
  copySelectionToClipboard: (tabId: string) => Promise<void>;
  /** Associate a backend session ID with a tab for paste support. */
  registerSession: (tabId: string, sessionId: SessionId) => void;
  /** Remove the session ID association for a tab. */
  unregisterSession: (tabId: string) => void;
  /** Paste clipboard text into a terminal by sending it as input. */
  pasteToTerminal: (tabId: string) => Promise<void>;
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
      requestAnimationFrame(() => xterm.scrollToBottom());
    }
  }, []);

  const clearTerminal = useCallback((tabId: string) => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (xterm) {
      xterm.clear();
    }
  }, []);

  const getTerminalContent = useCallback((tabId: string): string | undefined => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (!xterm) return undefined;

    const buffer = xterm.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString() : "");
    }

    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }

    return lines.join("\n") + "\n";
  }, []);

  const saveTerminalToFile = useCallback(
    async (tabId: string) => {
      const content = getTerminalContent(tabId);
      if (!content) return;

      const filePath = await save({
        title: "Save terminal content",
        defaultPath: "terminal-output.txt",
      });
      if (!filePath) return;

      await writeTextFile(filePath, content);
    },
    [getTerminalContent]
  );

  const copyTerminalToClipboard = useCallback(
    async (tabId: string) => {
      const content = getTerminalContent(tabId);
      if (!content) return;

      await navigator.clipboard.writeText(content);
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

      await navigator.clipboard.writeText(selection);
    },
    [getTerminalSelection]
  );

  const registerSession = useCallback((tabId: string, sessionId: SessionId) => {
    sessionRegistryRef.current.set(tabId, sessionId);
    useAppStore.getState().setTabSessionId(tabId, sessionId);
  }, []);

  const unregisterSession = useCallback((tabId: string) => {
    sessionRegistryRef.current.delete(tabId);
    useAppStore.getState().setTabSessionId(tabId, null);
  }, []);

  const pasteToTerminal = useCallback(async (tabId: string) => {
    const sessionId = sessionRegistryRef.current.get(tabId);
    if (!sessionId) return;
    const text = await readClipboard();
    if (!text) return;

    const doPaste = async () => {
      const xterm = xtermRegistryRef.current.get(tabId);
      let payload = text;

      // Wrap in bracketed paste escape sequences if the terminal supports it
      if (xterm && xterm.modes.bracketedPasteMode) {
        payload = `\x1b[200~${text}\x1b[201~`;
      }

      await sendInput(sessionId, payload);
    };

    if (text.length > LARGE_PASTE_THRESHOLD) {
      useAppStore.getState().showLargePasteDialog(text.length, doPaste);
    } else {
      await doPaste();
    }
  }, []);

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
      saveTerminalToFile,
      copyTerminalToClipboard,
      getTerminalSelection,
      clearTerminalSelection,
      copySelectionToClipboard,
      registerSession,
      unregisterSession,
      pasteToTerminal,
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
      saveTerminalToFile,
      copyTerminalToClipboard,
      getTerminalSelection,
      clearTerminalSelection,
      copySelectionToClipboard,
      registerSession,
      unregisterSession,
      pasteToTerminal,
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
