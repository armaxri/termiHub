import { useCallback } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button } from "@/components/ui";
import "./TerminalReconnectPrompt.css";

interface TerminalReconnectPromptProps {
  tabId: string;
}

/**
 * Small dialog that appears when the user presses Enter in view mode (the session
 * is dead and the disconnect overlay has been dismissed). Lets the user confirm
 * a reconnect or continue browsing the scrollback.
 */
export function TerminalReconnectPrompt({ tabId }: TerminalReconnectPromptProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  const dismissTerminalReconnectPrompt = useAppStore((s) => s.dismissTerminalReconnectPrompt);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const handleStay = useCallback(() => {
    dismissTerminalReconnectPrompt(tabId);
  }, [tabId, dismissTerminalReconnectPrompt]);

  return (
    <div className="terminal-reconnect-prompt" data-testid="terminal-reconnect-prompt">
      <div className="terminal-reconnect-prompt__dialog">
        <WifiOff size={20} className="terminal-reconnect-prompt__icon" />
        <p className="terminal-reconnect-prompt__message">
          This session has ended. Would you like to reconnect?
        </p>
        <div className="terminal-reconnect-prompt__actions">
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={13} />}
            onClick={handleReconnect}
            data-testid="terminal-reconnect-prompt-reconnect-btn"
            autoFocus
          >
            Reconnect
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleStay}
            data-testid="terminal-reconnect-prompt-stay-btn"
          >
            Stay in View Mode
          </Button>
        </div>
      </div>
    </div>
  );
}
