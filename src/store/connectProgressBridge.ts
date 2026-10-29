import { create } from "zustand";
import { onConnectProgress, type ConnectProgressEvent } from "@/services/events";
import type { ConnectStage } from "@/types/generated/ConnectStage";
import { tabIdFromConnectId } from "@/utils/connectStages";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/** The latest connect-stage report for one tab (#5068). */
export interface TabConnectProgress {
  /** The attempt it belongs to (`${tabId}:${retryCount}`). */
  connectId: string;
  /** The stage reached. */
  stage: ConnectStage;
  /** The backend's status line for it, if any. */
  status: string | null;
}

interface ConnectProgressState {
  byTab: Record<string, TabConnectProgress>;
}

/**
 * Per-tab connect progress, fed by the backend's `connect-progress` events.
 * Runtime-only and deliberately outside the app store: it is a pure display
 * feed for the connect overlay, cleared when a tab starts a new attempt.
 */
export const useConnectProgressStore = create<ConnectProgressState>(() => ({ byTab: {} }));

/** Fold one `connect-progress` event into the per-tab map. */
export function recordConnectProgress(event: ConnectProgressEvent): void {
  const tabId = tabIdFromConnectId(event.connectId);
  if (!tabId) return;
  useConnectProgressStore.setState((s) => ({
    byTab: {
      ...s.byTab,
      [tabId]: { connectId: event.connectId, stage: event.stage, status: event.status },
    },
  }));
}

/** Forget a tab's progress (a new attempt starts, or the tab closed). */
export function clearConnectProgress(tabId: string): void {
  useConnectProgressStore.setState((s) => {
    if (!(tabId in s.byTab)) return s;
    const { [tabId]: _dropped, ...rest } = s.byTab;
    return { byTab: rest };
  });
}

/** The latest progress for `tabId`, if any. */
export function useTabConnectProgress(tabId: string): TabConnectProgress | undefined {
  return useConnectProgressStore((s) => s.byTab[tabId]);
}

let subscribed: Promise<void> | null = null;

/** Subscribe to `connect-progress` once for the app's lifetime (idempotent). */
export function ensureConnectProgressSubscribed(): Promise<void> {
  if (!subscribed) {
    const failed = (err: unknown) => {
      subscribed = null;
      frontendLog("connect_progress", `subscribe failed: ${errorMessage(err)}`);
    };
    try {
      subscribed = onConnectProgress(recordConnectProgress).then(() => undefined, failed);
    } catch (err) {
      // A non-Tauri environment can throw synchronously; never propagate.
      failed(err);
      return Promise.resolve();
    }
  }
  return subscribed;
}
