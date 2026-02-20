import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onTunnelStatusChanged, onTunnelStatsUpdated } from "@/services/events";

/**
 * Hook that listens for tunnel status and stats events from the backend
 * and updates the store accordingly.
 */
export function useTunnelEvents(): void {
  const updateTunnelState = useAppStore((s) => s.updateTunnelState);

  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    let unlistenStats: (() => void) | null = null;

    const setup = async () => {
      unlistenStatus = await onTunnelStatusChanged((state) => {
        updateTunnelState(state);
      });

      unlistenStats = await onTunnelStatsUpdated((tunnelId, stats) => {
        const current = useAppStore.getState().tunnelStates[tunnelId];
        if (current) {
          updateTunnelState({ ...current, stats });
        }
      });
    };

    setup();

    return () => {
      unlistenStatus?.();
      unlistenStats?.();
    };
  }, [updateTunnelState]);
}
