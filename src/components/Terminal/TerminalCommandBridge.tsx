import { useEffect } from "react";
import { useTerminalRegistry } from "./TerminalRegistry";

/**
 * Bridges custom DOM events to TerminalRegistry methods.
 * Must be rendered inside TerminalPortalProvider so it has access to the registry context.
 * Keyboard shortcuts and the command palette (which run outside the provider) dispatch
 * events; this component listens and calls the appropriate registry methods, so a shortcut
 * and its palette entry both drive the identical registry handler.
 */
export function TerminalCommandBridge() {
  const {
    clearTerminal,
    focusTerminal,
    copySelectionToClipboard,
    pasteToTerminal,
    selectAllInTerminal,
  } = useTerminalRegistry();

  useEffect(() => {
    const withTabId = (handler: (tabId: string) => void) => (e: Event) => {
      const tabId = (e as CustomEvent<{ tabId: string }>).detail.tabId;
      if (tabId) handler(tabId);
    };

    const handleClear = withTabId(clearTerminal);
    const handleFocus = withTabId(focusTerminal);
    const handleCopy = withTabId((tabId) => void copySelectionToClipboard(tabId));
    const handlePaste = withTabId((tabId) => void pasteToTerminal(tabId));
    const handleSelectAll = withTabId(selectAllInTerminal);

    window.addEventListener("termihub:clear-terminal", handleClear);
    window.addEventListener("termihub:focus-terminal", handleFocus);
    window.addEventListener("termihub:copy-selection", handleCopy);
    window.addEventListener("termihub:paste", handlePaste);
    window.addEventListener("termihub:select-all", handleSelectAll);
    return () => {
      window.removeEventListener("termihub:clear-terminal", handleClear);
      window.removeEventListener("termihub:focus-terminal", handleFocus);
      window.removeEventListener("termihub:copy-selection", handleCopy);
      window.removeEventListener("termihub:paste", handlePaste);
      window.removeEventListener("termihub:select-all", handleSelectAll);
    };
  }, [
    clearTerminal,
    focusTerminal,
    copySelectionToClipboard,
    pasteToTerminal,
    selectAllInTerminal,
  ]);

  return null;
}
