import { useCallback, useRef } from "react";
import { WifiOff, RefreshCw, RotateCcw, SquareTerminal, CheckCircle2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, LiveRegion, TOAST_AVOID_PROPS } from "@/components/ui";
import { useTopNoticeInset } from "./topNoticeInset";
import { sessionEndActionLabel, type SessionEndNotice } from "./dropCopy";
import "./TerminalViewModeBanner.css";

interface TerminalViewModeBannerProps {
  tabId: string;
  /**
   * Why the session ended, as the one cause line the overlay and the strip
   * show (#5831): "The server closed the connection.", "You disconnected this
   * session.". Shown under the heading; omitted when unknown.
   */
  cause?: string;
  /**
   * The session-end notice (#5910): a process exit reads "Process exited (code
   * N)." with Restart, a dropped link "Session ended." with Reconnect. Its
   * cause line is used when `cause` is not given.
   */
  notice?: SessionEndNotice;
}

/** The short hint after the banner's heading (#5823). */
export const VIEW_MODE_ENTER_HINT = "Press Enter to reconnect.";

/** The hint when Enter starts a local process again (#5910). */
export const VIEW_MODE_RESTART_HINT = "Press Enter to restart.";

/**
 * The hint after the user disconnected the tab's agent (#5980): Reconnect
 * brings the agent back and resumes the tab's own session, which kept running
 * on the agent host (#5953). Only when the agent no longer runs it does a new
 * session start, and the tab's marker then says so.
 */
export const VIEW_MODE_RESUME_HINT = "Press Enter to resume.";

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
export function TerminalViewModeBanner({ tabId, cause, notice }: TerminalViewModeBannerProps) {
  const reconnectTerminal = useAppStore((s) => s.reconnectTerminal);
  // The user disconnected or shut down this tab's agent (#4309): say so, since
  // Reconnect will bring the agent back and resume the session (#5953).
  const agentDisconnected = useAppStore((s) => s.terminalAgentDisconnected[tabId] ?? false);

  const bannerRef = useRef<HTMLDivElement>(null);
  // The terminal search bar opens below the banner, not over Reconnect.
  useTopNoticeInset(bannerRef);

  const handleReconnect = useCallback(() => {
    reconnectTerminal(tabId);
  }, [tabId, reconnectTerminal]);

  // A process exit is not a lost connection (#5910): it says so and restarts.
  // Only the process kinds change the heading; any other end keeps the short
  // "Session ended." of #5823.
  const processEnd = !agentDisconnected && notice?.kind === "exited";
  const restart = !agentDisconnected && notice?.action === "restart";
  const heading = agentDisconnected
    ? "Agent disconnected."
    : processEnd
      ? `${notice.heading}.`
      : "Session ended.";
  const actionLabel = sessionEndActionLabel(restart ? "restart" : "reconnect");
  const hint = agentDisconnected
    ? VIEW_MODE_RESUME_HINT
    : restart
      ? VIEW_MODE_RESTART_HINT
      : VIEW_MODE_ENTER_HINT;
  const reconnectTitle = agentDisconnected
    ? "Reconnect the agent and resume the session (Enter)"
    : restart
      ? "Start the process again (Enter)"
      : "Start a new session (Enter)";
  // The agent heading already says what happened; every other end states its
  // cause (#5831).
  const causeLine = agentDisconnected ? undefined : (cause ?? notice?.causeLine);
  // One string for the eye and the screen reader (#5980): the announcement is
  // the banner's own visible text. It used to promise "a new session" while
  // Reconnect resumed the agent's session.
  const announcement = [heading, hint, causeLine].filter(Boolean).join(" ");
  const Icon = processEnd ? SquareTerminal : notice?.kind === "ended" ? CheckCircle2 : WifiOff;

  return (
    <div
      ref={bannerRef}
      className="terminal-view-mode-banner"
      data-testid="terminal-view-mode-banner"
      {...TOAST_AVOID_PROPS}
    >
      {/* The banner can appear without the disconnect overlay (the user ended
          the agent, #4309), so announce its state politely (#4331). */}
      <LiveRegion message={announcement} data-testid="terminal-view-mode-announcement" />
      <Icon size={12} className="terminal-view-mode-banner__icon" aria-hidden />
      <span className="terminal-view-mode-banner__text">
        <span className="terminal-view-mode-banner__label">
          <span className="terminal-view-mode-banner__heading">{heading}</span>{" "}
          <span className="terminal-view-mode-banner__hint">{hint}</span>
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
        icon={restart ? <RotateCcw size={11} /> : <RefreshCw size={11} />}
        onClick={handleReconnect}
        title={reconnectTitle}
        data-testid="terminal-view-mode-reconnect-btn"
      >
        {actionLabel}
      </Button>
    </div>
  );
}
