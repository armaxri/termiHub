import { useCallback, useRef } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, LiveRegion, TOAST_AVOID_PROPS } from "@/components/ui";
import { useTopNoticeInset } from "./topNoticeInset";
import "./TerminalViewModeBanner.css";

interface TerminalViewModeBannerProps {
  tabId: string;
  /**
   * Why the session ended, as the one cause line the overlay and the strip
   * show (#5831): "The server closed the connection.", "You disconnected this
   * session.". Shown under the heading; omitted when unknown.
   */
  cause?: string;
}

/** The short hint after the banner's heading (#5823). */
export const VIEW_MODE_ENTER_HINT = "Press Enter to reconnect.";

/**
 * Thin non-blocking banner pinned to the top of the terminal slot when the
 * disconnect overlay has been dismissed and the user is browsing the scrollback.
 * Keeps the terminal fully interactive for selection and copy while clearly
 * marking the session as dead.
 *
 * #5823: it used to sit at the bottom edge with one long nowrap sentence, so at
 * 800x600 the text was cut off and a toast covered its Reconnect button. It now
 * sits at the top like the reconnect strip, says a short heading plus a hint
 * that wraps instead of clipping, keeps Reconnect from shrinking, and is a
 * toast keep-clear zone so the toast stack never covers it.
 */
export function TerminalViewModeBanner({ tabId, cause }: TerminalViewModeBannerProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  // The user disconnected or shut down this tab's agent (#4309): say so, since
  // Reconnect will bring the agent back before starting a new session.
  const agentDisconnected = useAppStore((s) => s.terminalAgentDisconnected[tabId] ?? false);

  const bannerRef = useRef<HTMLDivElement>(null);
  // The terminal search bar opens below the banner, not over Reconnect.
  useTopNoticeInset(bannerRef);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  const heading = agentDisconnected ? "Agent disconnected." : "Session ended.";
  const reconnectTitle = agentDisconnected
    ? "Reconnect the agent and start a new session (Enter)"
    : "Start a new session (Enter)";
  // The agent heading already says what happened; every other end states its
  // cause (#5831).
  const causeLine = agentDisconnected ? undefined : cause;
  const announcement = agentDisconnected
    ? "Agent disconnected. Press Enter or click Reconnect to reconnect it and start a new session."
    : `Session ended.${causeLine ? ` ${causeLine}` : ""} Press Enter or click Reconnect to start a new session.`;

  return (
    <div
      ref={bannerRef}
      className="terminal-view-mode-banner"
      data-testid="terminal-view-mode-banner"
      {...TOAST_AVOID_PROPS}
    >
      {/* The banner can appear without the disconnect overlay (the user ended
          the agent, #4309), so announce its state politely (#4331). */}
      <LiveRegion message={announcement} />
      <WifiOff size={12} className="terminal-view-mode-banner__icon" aria-hidden />
      <span className="terminal-view-mode-banner__text">
        <span className="terminal-view-mode-banner__label">
          <span className="terminal-view-mode-banner__heading">{heading}</span>{" "}
          <span className="terminal-view-mode-banner__hint">{VIEW_MODE_ENTER_HINT}</span>
        </span>
        {causeLine && (
          <span className="terminal-view-mode-banner__cause" data-testid="terminal-view-mode-cause">
            {causeLine}
          </span>
        )}
      </span>
      <Button
        variant="primary"
        size="sm"
        icon={<RefreshCw size={11} />}
        onClick={handleReconnect}
        title={reconnectTitle}
        data-testid="terminal-view-mode-reconnect-btn"
      >
        Reconnect
      </Button>
    </div>
  );
}
