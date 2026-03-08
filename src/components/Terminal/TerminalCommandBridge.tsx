import { useEffect } from "react";
import { useTerminalRegistry } from "./TerminalRegistry";

/**
 * Bridges custom DOM events to TerminalRegistry methods.
 * Must be rendered inside TerminalPortalProvider so it has access to the registry context.
 * Keyboard shortcuts (which run outside the provider) dispatch events; this component
 * listens and calls the appropriate registry methods.
 */
export function TerminalCommandBridge() {
  const { clearTerminal, focusTerminal } = useTerminalRegistry();

  useEffect(() => {
    const handleClear = (e: Event) => {
      const tabId = (e as CustomEvent<{ tabId: string }>).detail.tabId;
      if (tabId) clearTerminal(tabId);
    };

    const handleFocus = (e: Event) => {
      const tabId = (e as CustomEvent<{ tabId: string }>).detail.tabId;
      if (tabId) focusTerminal(tabId);
    };

    window.addEventListener("termihub:clear-terminal", handleClear);
    window.addEventListener("termihub:focus-terminal", handleFocus);
    return () => {
      window.removeEventListener("termihub:clear-terminal", handleClear);
      window.removeEventListener("termihub:focus-terminal", handleFocus);
    };
  }, [clearTerminal, focusTerminal]);

  return null;
}
