/**
 * First-use credential-storage choice (#5187).
 *
 * A fresh install keeps credential storage off (`none`) and has not chosen yet
 * (`storageChosen: false` from the backend). The first attempt to save a
 * secret — ticking a "Save password" box or the editor's "Save credentials"
 * toggle — opens the one-time storage chooser instead of a disabled control.
 * Nothing is saved until the chooser settles on a store: the chooser switches
 * the store first, and the caller's normal save path then writes into it.
 */

import { useAppStore } from "@/store/appStore";
import type { CredentialStorageMode, CredentialStoreStatusInfo } from "@/types/credential";

/**
 * Whether the next secret-saving attempt must ask where to store it: the mode
 * is still the untouched `none` default and no choice was recorded. A status
 * without `storageChosen` (not loaded, or an older backend) never asks.
 */
export function credentialStorageNeedsChoice(
  status: CredentialStoreStatusInfo | null | undefined
): boolean {
  return status?.mode === "none" && status.storageChosen === false;
}

/** Whether a credential store is active (any mode other than `none`). */
export function credentialStoreActive(status: CredentialStoreStatusInfo | null | undefined) {
  return status != null && status.mode !== "none";
}

/**
 * Make sure a store is chosen before saving a secret. Opens the chooser when
 * no choice was made yet and resolves `true` only when a store is active
 * afterwards — `false` when the user canceled (nothing chosen, asked again
 * next time), chose "Don't save", or storage is off by an earlier choice.
 */
export async function ensureCredentialStorageForSave(): Promise<boolean> {
  return (await chooseCredentialStorageForSave()).active;
}

/**
 * Like {@link ensureCredentialStorageForSave}, but also says which store the
 * chooser just set up (#5825), so the save control can name it in place
 * instead of a toast. `chosen` is `null` when no chooser was shown (a store
 * was already active, or storage is off by an earlier choice) or it was
 * dismissed.
 */
export async function chooseCredentialStorageForSave(): Promise<{
  active: boolean;
  chosen: CredentialStorageMode | null;
}> {
  const { credentialStoreStatus, requestStorageChoice } = useAppStore.getState();
  if (!credentialStorageNeedsChoice(credentialStoreStatus)) {
    return { active: credentialStoreActive(credentialStoreStatus), chosen: null };
  }
  const outcome = await requestStorageChoice("save");
  const active = outcome !== "canceled" && outcome !== "none";
  return { active, chosen: active ? outcome : null };
}

/**
 * Run `save` once a store is active (#5867). A connect-time password prompt
 * ticked "Save password" before any storage choice exists does not open the
 * chooser over itself: the box ticks locally, and the save path calls this
 * once the connect has succeeded. It asks where to keep passwords then (the
 * one-time chooser, purpose `"save"`) and saves into the chosen store.
 * Dismissing the chooser, or a store that stays off, saves nothing and
 * resolves `false`. With a store already active it just saves.
 */
export async function saveAfterStorageChoice(save: () => Promise<void>): Promise<boolean> {
  if (!(await ensureCredentialStorageForSave())) return false;
  await save();
  return true;
}

/**
 * The credential-store state a "save" control renders from: whether a store is
 * active, and whether ticking the control first asks where to store (#5187).
 */
export function useCredentialStorageChoice(): { storeActive: boolean; needsChoice: boolean } {
  const status = useAppStore((s) => s.credentialStoreStatus);
  return {
    storeActive: credentialStoreActive(status),
    needsChoice: credentialStorageNeedsChoice(status),
  };
}
