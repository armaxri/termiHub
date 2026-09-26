import { useEffect } from "react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { getCommandMarkTracker } from "@/services/commandMarks";
import { useTerminalRegistry } from "./TerminalRegistry";

/**
 * Copy the output of the tab's last finished command (OSC 133 marks, #3415) to
 * the OS clipboard. A no-op when the shell emits no marks or no command with
 * output has finished yet.
 */
async function copyLastCommandOutput(tabId: string): Promise<void> {
  const text = getCommandMarkTracker(tabId)?.getLastCommandOutput();
  if (!text) return;
  // Tauri clipboard plugin, like the other copy paths: the web clipboard API
  // rejects on macOS/WKWebView when the document isn't focused.
  await writeClipboard(text);
}

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
    // OSC 133 command-mark actions (#3415) act on the tab's mark tracker.
    const handleJumpPrevPrompt = withTabId((tabId) => {
      getCommandMarkTracker(tabId)?.jumpToPreviousPrompt();
    });
    const handleJumpNextPrompt = withTabId((tabId) => {
      getCommandMarkTracker(tabId)?.jumpToNextPrompt();
    });
    const handleSelectLastOutput = withTabId((tabId) => {
      getCommandMarkTracker(tabId)?.selectLastCommandOutput();
    });
    const handleCopyLastOutput = withTabId((tabId) => void copyLastCommandOutput(tabId));

    window.addEventListener("termihub:clear-terminal", handleClear);
    window.addEventListener("termihub:focus-terminal", handleFocus);
    window.addEventListener("termihub:copy-selection", handleCopy);
    window.addEventListener("termihub:paste", handlePaste);
    window.addEventListener("termihub:select-all", handleSelectAll);
    window.addEventListener("termihub:jump-prev-prompt", handleJumpPrevPrompt);
    window.addEventListener("termihub:jump-next-prompt", handleJumpNextPrompt);
    window.addEventListener("termihub:select-last-command-output", handleSelectLastOutput);
    window.addEventListener("termihub:copy-last-command-output", handleCopyLastOutput);
    return () => {
      window.removeEventListener("termihub:clear-terminal", handleClear);
      window.removeEventListener("termihub:focus-terminal", handleFocus);
      window.removeEventListener("termihub:copy-selection", handleCopy);
      window.removeEventListener("termihub:paste", handlePaste);
      window.removeEventListener("termihub:select-all", handleSelectAll);
      window.removeEventListener("termihub:jump-prev-prompt", handleJumpPrevPrompt);
      window.removeEventListener("termihub:jump-next-prompt", handleJumpNextPrompt);
      window.removeEventListener("termihub:select-last-command-output", handleSelectLastOutput);
      window.removeEventListener("termihub:copy-last-command-output", handleCopyLastOutput);
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
