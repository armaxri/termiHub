import { useCallback } from "react";
import { MonitorX, RefreshCw } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSessionLifecycle } from "@/store/useSessionLifecycle";
import { Button, ContentOverlay } from "@/components/ui";
import "./TerminalDisconnectOverlay.css";

interface TerminalEvictedOverlayProps {
  tabId: string;
  /**
   * Called right before the Reclaim attach is sent. The caller clears this tab's
   * stale screen so the daemon's buffer replay repaints it cleanly instead of
   * appending a duplicate of the scrollback.
   */
  onBeforeReclaim?: () => void;
  /**
   * Whether this tab is the active (visible) one. Moves focus to **Reclaim**
   * when the overlay appears (#4514); background tabs never steal focus.
   */
  isActive?: boolean;
}

/**
 * "Taken over by another desktop" overlay (SM-003, maintainer decision:
 * single-attach). Only one desktop or window controls a session at a time; when
 * another one attaches, this tab rests in the sticky `evicted` state — the session
 * is alive elsewhere, input is not sent, and nothing reconnects on its own (that
 * would ping-pong control). The only way back is the explicit **Reclaim** action,
 * which takes control (evicting the other side in turn).
 */
export function TerminalEvictedOverlay({
  tabId,
  onBeforeReclaim,
  isActive = false,
}: TerminalEvictedOverlayProps) {
  const reclaimSession = useAppStore((s) => s.reclaimSession);
  const lifecycle = useProjectedSessionLifecycle(tabId);
  // An async handler opts the Button into its pending lifecycle (disabled +
  // spinner while the takeover attach is in flight), so a double click can never
  // fire two reclaims. The store action already toasts a failure.
  const handleReclaim = useCallback(async () => {
    onBeforeReclaim?.();
    await reclaimSession(tabId);
  }, [tabId, reclaimSession, onBeforeReclaim]);

  if (!lifecycle.evicted) return null;

  return (
    <EvictedOverlayView
      evictedBy="desktop"
      heading="Taken over by another desktop"
      subheading="This session is still running, but another desktop or window is now controlling it. Input is paused here until you reclaim it."
      onReclaim={handleReclaim}
      isActive={isActive}
    />
  );
}

interface TerminalWindowEvictedOverlayProps {
  /** The tab's session, taken over by another window of this app. */
  sessionId: string;
  /** The window that now controls the session (name shown in the copy). */
  controllingWindowName: string;
  /** Called right before the claim is sent (see {@link TerminalEvictedOverlayProps}). */
  onBeforeReclaim?: () => void;
  /** Whether this tab is the active one (see {@link TerminalEvictedOverlayProps}). */
  isActive?: boolean;
}

/**
 * "Taken over by another window" overlay (#3368) — the same-machine,
 * multi-window counterpart of {@link TerminalEvictedOverlay}. Only one window
 * controls a session; when another window takes it over, this window keeps
 * rendering the tab but its input and resize are dropped (in the backend too)
 * until the user explicitly presses **Reclaim**, which claims the session for
 * this window and evicts the other one in turn. Nothing reclaims automatically.
 */
export function TerminalWindowEvictedOverlay({
  sessionId,
  controllingWindowName,
  onBeforeReclaim,
  isActive = false,
}: TerminalWindowEvictedOverlayProps) {
  const reclaimWindowSession = useAppStore((s) => s.reclaimWindowSession);
  const handleReclaim = useCallback(async () => {
    onBeforeReclaim?.();
    await reclaimWindowSession(sessionId);
  }, [sessionId, reclaimWindowSession, onBeforeReclaim]);

  return (
    <EvictedOverlayView
      evictedBy="window"
      heading="Taken over by another window"
      subheading={`This session is still running, but ${controllingWindowName} is now controlling it. Input and resize are paused here until you reclaim it.`}
      onReclaim={handleReclaim}
      isActive={isActive}
    />
  );
}

/** Shared presentation of both eviction variants (one consistent signal). */
function EvictedOverlayView({
  evictedBy,
  heading,
  subheading,
  onReclaim,
  isActive,
}: {
  evictedBy: "desktop" | "window";
  heading: string;
  subheading: string;
  onReclaim: () => Promise<void>;
  isActive: boolean;
}) {
  // An async handler opts the Button into its pending lifecycle (disabled +
  // spinner while the reclaim is in flight), so a double click can never fire
  // two reclaims. The store actions already toast a failure.
  return (
    <div
      className="terminal-disconnect-overlay terminal-disconnect-overlay--evicted"
      data-testid="terminal-evicted-overlay"
      data-evicted-by={evictedBy}
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        icon={<MonitorX size={32} className="terminal-disconnect-overlay__icon" />}
        heading={heading}
        subheading={subheading}
        // A state change, not a failure: the session is alive elsewhere (#4514).
        announce="polite"
        autoFocusPrimaryAction={isActive}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={onReclaim}
            data-testid="terminal-evicted-reclaim-btn"
          >
            Reclaim
          </Button>
        }
      />
    </div>
  );
}
