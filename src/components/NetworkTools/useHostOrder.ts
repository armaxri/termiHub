import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { useProjectedSettings } from "@/store/useProjectedSettings";

/** Row order of a Network Tools host list (#5067). */
export type HostOrder = "address" | "response";

/** Default order when the user has not chosen one. */
const DEFAULT_HOST_ORDER: HostOrder = "address";

/**
 * The remembered host-list order shared by the Ping Sweep and Port Scanner
 * tables, persisted in `AppSettings.networkHostOrder` so it survives restarts.
 */
export function useHostOrder(): { order: HostOrder; setOrder: (order: HostOrder) => void } {
  const settings = useProjectedSettings();
  const updateSettings = useAppStore((s) => s.updateSettings);
  const stored = settings.networkHostOrder;
  const order: HostOrder =
    stored === "response" || stored === "address" ? stored : DEFAULT_HOST_ORDER;

  const setOrder = useCallback(
    (next: HostOrder) => {
      if (next === order) return;
      void updateSettings({ ...settings, networkHostOrder: next });
    },
    [order, settings, updateSettings]
  );

  return { order, setOrder };
}
