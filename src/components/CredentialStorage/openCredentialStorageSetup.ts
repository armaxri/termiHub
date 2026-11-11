import { useAppStore } from "@/store/appStore";
import { credentialStorageNeedsChoice } from "@/utils/credentialStorageChoice";

/**
 * Take the user to where credential storage is turned on (#5186).
 *
 * Every "Enable credential storage…" action routes through here. Before any
 * storage choice exists this opens the first-use storage chooser (#5187);
 * once a choice was made (e.g. "Don't save passwords") it opens Settings ▸
 * Security, where the choice can be changed.
 */
export function openCredentialStorageSetup(): void {
  const state = useAppStore.getState();
  if (credentialStorageNeedsChoice(state.credentialStoreStatus)) {
    void state.requestStorageChoice();
    return;
  }
  state.openSettingsTab({ category: "security" });
}
