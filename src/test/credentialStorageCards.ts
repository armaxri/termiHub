import { CREDENTIAL_STORAGE_CHOICES } from "@/utils/credentialStorageCopy";

/** One rendered credential-storage card, as the user reads it. */
interface StorageCardView {
  label: string;
  badge: string | null;
  description: string;
}

/**
 * Read the credential-storage radio cards inside `group` in DOM order, so the
 * first-use chooser and Settings ▸ Security can each be checked against the
 * one shared option list (#5553).
 */
export function readStorageCards(group: Element): StorageCardView[] {
  return Array.from(group.querySelectorAll(".ui-radio-card")).map((card) => ({
    label: card.querySelector(".ui-radio-card__label > span:not([class])")?.textContent ?? "",
    badge: card.querySelector(".credential-storage-option__badge")?.textContent ?? null,
    description: card.querySelector(".ui-radio-card__desc")?.textContent ?? "",
  }));
}

/** What every surface must show: the shared list, in its order. */
export function expectedStorageCards(): StorageCardView[] {
  return CREDENTIAL_STORAGE_CHOICES.map((c) => ({
    label: c.label,
    badge: c.badge ?? null,
    description: c.description,
  }));
}
