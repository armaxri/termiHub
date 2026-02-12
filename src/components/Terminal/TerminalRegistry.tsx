import { createContext, useContext, useRef, useCallback, useMemo, ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";

interface TerminalRegistryContextType {
  /** Register a terminal's xterm container element and xterm instance. */
  register: (tabId: string, element: HTMLDivElement, xterm: XTerm) => void;
  /** Unregister a terminal element (on terminal close). */
  unregister: (tabId: string) => void;
  /** Get the registered element for a tab. */
  getElement: (tabId: string) => HTMLDivElement | undefined;
  /** Clear the terminal scrollback and screen for a tab. */
  clearTerminal: (tabId: string) => void;
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
  const parkingRef = useRef<HTMLDivElement | null>(null);

  const register = useCallback((tabId: string, element: HTMLDivElement, xterm: XTerm) => {
    registryRef.current.set(tabId, element);
    xtermRegistryRef.current.set(tabId, xterm);
  }, []);

  const unregister = useCallback((tabId: string) => {
    registryRef.current.delete(tabId);
    xtermRegistryRef.current.delete(tabId);
  }, []);

  const getElement = useCallback((tabId: string) => {
    return registryRef.current.get(tabId);
  }, []);

  const clearTerminal = useCallback((tabId: string) => {
    const xterm = xtermRegistryRef.current.get(tabId);
    if (xterm) {
      xterm.clear();
    }
  }, []);

  const ctx = useMemo(
    () => ({ register, unregister, getElement, clearTerminal, parkingRef }),
    [register, unregister, getElement, clearTerminal]
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
