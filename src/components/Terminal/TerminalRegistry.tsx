import { createContext, useContext, useRef, useCallback, useMemo, ReactNode } from "react";

interface TerminalRegistryContextType {
  /** Register a terminal's xterm container element. */
  register: (tabId: string, element: HTMLDivElement) => void;
  /** Unregister a terminal element (on terminal close). */
  unregister: (tabId: string) => void;
  /** Get the registered element for a tab. */
  getElement: (tabId: string) => HTMLDivElement | undefined;
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
  const parkingRef = useRef<HTMLDivElement | null>(null);

  const register = useCallback((tabId: string, element: HTMLDivElement) => {
    registryRef.current.set(tabId, element);
  }, []);

  const unregister = useCallback((tabId: string) => {
    registryRef.current.delete(tabId);
  }, []);

  const getElement = useCallback((tabId: string) => {
    return registryRef.current.get(tabId);
  }, []);

  const ctx = useMemo(
    () => ({ register, unregister, getElement, parkingRef }),
    [register, unregister, getElement]
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
