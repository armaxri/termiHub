import { create } from "zustand";
import { onSshHostKeyTrusted } from "@/services/events";
import type { SshHostKeyTrustedEvent } from "@/types/generated/SshHostKeyTrustedEvent";
import { tabIdFromConnectId } from "@/utils/connectStages";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

interface SshHostKeyTrustState {
  /**
   * Per tab, the host keys its latest connect attempt accepted — one per
   * `host:port`, so a jump chain keeps the bastion's and the target's apart.
   */
  byTab: Record<string, SshHostKeyTrustedEvent[]>;
}

/**
 * Per-tab SSH host-key trust (#5669), fed by the backend's
 * `ssh-host-key-trusted` events. Runtime-only and outside the app store: a
 * display feed for the status-bar SSH chip's tooltip.
 */
export const useSshHostKeyTrustStore = create<SshHostKeyTrustState>(() => ({ byTab: {} }));

/**
 * Fold one `ssh-host-key-trusted` event: a report from a newer attempt of the
 * tab replaces the earlier attempt's keys; one from the same attempt replaces
 * only the entry for its `host:port`.
 */
export function recordSshHostKeyTrust(event: SshHostKeyTrustedEvent): void {
  const tabId = tabIdFromConnectId(event.owner);
  if (!tabId) return;
  useSshHostKeyTrustStore.setState((s) => {
    const kept = (s.byTab[tabId] ?? []).filter(
      (e) => e.owner === event.owner && (e.host !== event.host || e.port !== event.port)
    );
    return { byTab: { ...s.byTab, [tabId]: [...kept, event] } };
  });
}

const NONE: SshHostKeyTrustedEvent[] = [];

/** The host keys `tabId`'s latest connect accepted (stable empty list when none). */
export function useTabSshHostKeyTrust(tabId: string | undefined): SshHostKeyTrustedEvent[] {
  return useSshHostKeyTrustStore((s) => (tabId ? (s.byTab[tabId] ?? NONE) : NONE));
}

let subscribed: Promise<void> | null = null;

/** Subscribe to `ssh-host-key-trusted` once for the app's lifetime (idempotent). */
export function ensureSshHostKeyTrustSubscribed(): Promise<void> {
  if (!subscribed) {
    const failed = (err: unknown) => {
      subscribed = null;
      frontendLog("ssh_host_key_trust", `subscribe failed: ${errorMessage(err)}`);
    };
    try {
      subscribed = onSshHostKeyTrusted(recordSshHostKeyTrust).then(() => undefined, failed);
    } catch (err) {
      // A non-Tauri environment can throw synchronously; never propagate.
      failed(err);
      return Promise.resolve();
    }
  }
  return subscribed;
}
