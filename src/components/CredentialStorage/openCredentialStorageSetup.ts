import { useAppStore } from "@/store/appStore";

/**
 * Take the user to where credential storage is turned on (#5186).
 *
 * Today that is Settings ▸ Security. This is the single seam the first-use
 * storage chooser (#5187) replaces: every "Enable credential storage…" action
 * routes through here, so swapping the target is a one-line change.
 */
export function openCredentialStorageSetup(): void {
  useAppStore.getState().openSettingsTab({ category: "security" });
}
