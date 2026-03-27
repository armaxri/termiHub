import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onEmbeddedServerStatusChanged } from "@/services/events";

/**
 * Hook that listens for embedded server status events from the backend
 * and keeps the store's `embeddedServerStates` map up to date.
 */
export function useEmbeddedServerEvents(): void {
  const updateEmbeddedServerState = useAppStore((s) => s.updateEmbeddedServerState);

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
}
