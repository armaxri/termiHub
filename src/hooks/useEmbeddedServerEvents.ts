import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onEmbeddedServerStatusChanged } from "@/services/events";

/** How often to poll live server stats while at least one server is running (#1145, GAP G6). */
const STATS_POLL_INTERVAL_MS = 1500;

/**
 * Hook that keeps the store's `embeddedServerStates` map up to date:
 *
 * 1. Subscribes to backend status-changed events (fired on transitions).
 * 2. While any server is running, polls the real runtime states on an interval
 *    so the sidebar's live traffic line and uptime keep updating — status
 *    events only fire on transitions, not on continuous traffic (#1145, G6).
 */
export function useEmbeddedServerEvents(): void {
  const updateEmbeddedServerState = useAppStore((s) => s.updateEmbeddedServerState);
  const refreshEmbeddedServerStates = useAppStore((s) => s.refreshEmbeddedServerStates);
  const hasRunningServer = useAppStore((s) =>
    Object.values(s.embeddedServerStates).some((state) => state.status === "running")
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await onEmbeddedServerStatusChanged((state) => {
        updateEmbeddedServerState(state);
      });
    };

    setup();

    return () => {
      unlisten?.();
    };
  }, [updateEmbeddedServerState]);

  useEffect(() => {
    if (!hasRunningServer) return;
    const interval = window.setInterval(() => {
      void refreshEmbeddedServerStates();
    }, STATS_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasRunningServer, refreshEmbeddedServerStates]);
}
