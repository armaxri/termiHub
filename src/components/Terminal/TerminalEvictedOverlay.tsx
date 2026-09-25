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
}

/**
 * "Taken over by another desktop" overlay (SM-003, maintainer decision:
 * single-attach). Only one desktop or window controls a session at a time; when
 * another one attaches, this tab rests in the sticky `evicted` state — the session
 * is alive elsewhere, input is not sent, and nothing reconnects on its own (that
 * would ping-pong control). The only way back is the explicit **Reclaim** action,
 * which takes control (evicting the other side in turn).
 */
export function TerminalEvictedOverlay({ tabId, onBeforeReclaim }: TerminalEvictedOverlayProps) {
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
    <div
      className="terminal-disconnect-overlay terminal-disconnect-overlay--evicted"
      data-testid="terminal-evicted-overlay"
    >
      <ContentOverlay
        className="terminal-disconnect-overlay__body"
        icon={<MonitorX size={32} className="terminal-disconnect-overlay__icon" />}
        heading="Taken over by another desktop"
        subheading="This session is still running, but another desktop or window is now controlling it. Input is paused here until you reclaim it."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={handleReclaim}
            data-testid="terminal-evicted-reclaim-btn"
          >
            Reclaim
          </Button>
        }
      />
    </div>
  );
}
