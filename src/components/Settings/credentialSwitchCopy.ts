import type { CredentialStorageMode, SwitchCredentialStoreResult } from "@/types/credential";
import { t, tf } from "@/i18n/catalog";

/**
 * How many passwords the current store holds, as the switch confirmation uses
 * it: a number, or `null` when it is unknown (#5837).
 */
export type SavedPasswordCount = number | null;

/** The wording of one credential-storage switch confirmation (#5629, #5837). */
export interface SwitchConfirmCopy {
  /** Dialog title naming the action. */
  title: string;
  /** What happens to the saved passwords and the master-password vault. */
  text: string;
  /** Confirm-button label naming the action (never a bare "Confirm"). */
  action: string;
  /** The switch deletes saved passwords, so the confirm is a danger action. */
  destructive: boolean;
}

/** "2 saved passwords", for sentences in the confirmation and the result. */
export function savedPasswords(count: number): string {
  return tf(count === 1 ? "credentialSwitch.passwords.one" : "credentialSwitch.passwords.other", {
    count,
  });
}

/** Where a storing mode keeps passwords: "the OS Keychain" / "your master-password vault". */
export function storagePlace(mode: CredentialStorageMode): string {
  return t(
    mode === "os_keychain" ? "credentialSwitch.place.keychain" : "credentialSwitch.place.vault"
  );
}

/**
 * The count the confirmation can trust, from the raw `count_saved_credentials`
 * answer. Anything but a whole number is unknown. An OS Keychain count of 0
 * is unknown too: the keychain lists its keys from termiHub's key index, which
 * can miss items saved before the index existed, so "nothing saved" there is
 * not proven and a deleting switch must still ask.
 */
export function trustedSavedCount(from: CredentialStorageMode, raw: unknown): SavedPasswordCount {
  if (from === "none") return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return null;
  if (from === "os_keychain" && raw === 0) return null;
  return raw;
}

/**
 * Whether switching `from` → `to` needs the confirmation (#5837). A switch
 * that moves or deletes saved passwords asks first; one with nothing saved
 * (a known count of 0, or no storage before) switches at once. A switch to a
 * master password always shows its setup form instead, which is its own
 * confirmation.
 */
export function needsSwitchConfirm(
  from: CredentialStorageMode,
  to: CredentialStorageMode,
  count: SavedPasswordCount
): boolean {
  if (to === "master_password" || from === to) return false;
  if (from === "none") return false;
  return count !== 0;
}

/**
 * Copy for the confirmation shown before switching credential storage from
 * `from` to `to` with `count` saved passwords. Each one names its action, how
 * many passwords it touches and from where, and what happens to them,
 * matching the backend: a move copies the passwords and leaves the source in
 * place (the vault file is kept, locked), and a switch to `none` deletes them
 * from the source.
 */
export function switchConfirmCopy(
  from: CredentialStorageMode,
  to: CredentialStorageMode,
  count: SavedPasswordCount = null
): SwitchConfirmCopy {
  const counted = count !== null && count > 0;
  const passwords = counted ? savedPasswords(count) : "";
  if (to === "none") {
    const source = storagePlace(from);
    return {
      title: t("credentialSwitch.confirm.toNone.title"),
      text: counted
        ? tf("credentialSwitch.confirm.toNone.text", { passwords, source })
        : tf("credentialSwitch.confirm.toNone.textUncounted", { source }),
      action: t("credentialSwitch.confirm.toNone.action"),
      destructive: true,
    };
  }
  if (to === "os_keychain") {
    const move = from === "master_password" && count !== 0;
    if (!move) {
      return {
        title: t("credentialSwitch.confirm.toKeychain.fresh.title"),
        text: t("credentialSwitch.confirm.toKeychain.fresh.text"),
        action: t("credentialSwitch.confirm.toKeychain.fresh.action"),
        destructive: false,
      };
    }
    return {
      title: counted
        ? tf("credentialSwitch.confirm.toKeychain.move.title", { passwords })
        : t("credentialSwitch.confirm.toKeychain.moveUncounted.title"),
      text: t("credentialSwitch.confirm.toKeychain.move.text"),
      action: t("credentialSwitch.confirm.toKeychain.move.action"),
      destructive: false,
    };
  }
  const move = from === "os_keychain" && count !== 0;
  if (!move) {
    return {
      title: t("credentialSwitch.confirm.toMaster.fresh.title"),
      text: t("credentialSwitch.confirm.toMaster.fresh.text"),
      action: t("credentialSwitch.confirm.toMaster.fresh.action"),
      destructive: false,
    };
  }
  return {
    title: counted
      ? tf("credentialSwitch.confirm.toMaster.move.title", { passwords })
      : t("credentialSwitch.confirm.toMaster.moveUncounted.title"),
    text: t("credentialSwitch.confirm.toMaster.move.text"),
    action: t("credentialSwitch.confirm.toMaster.move.action"),
    destructive: false,
  };
}

/**
 * Progress text while a switch runs (#5837): "Moving 2 passwords…",
 * "Deleting saved passwords…", or "Switching…" when nothing is moved.
 */
export function switchProgressLabel(
  from: CredentialStorageMode,
  to: CredentialStorageMode,
  count: SavedPasswordCount
): string {
  if (from === "none" || count === 0) return t("credentialSwitch.progress.switch");
  const deleting = to === "none";
  if (count === null) {
    return t(
      deleting
        ? "credentialSwitch.progress.deleteUncounted"
        : "credentialSwitch.progress.moveUncounted"
    );
  }
  const passwords = tf(
    count === 1 ? "credentialSwitch.progress.count.one" : "credentialSwitch.progress.count.other",
    { count }
  );
  return tf(deleting ? "credentialSwitch.progress.delete" : "credentialSwitch.progress.move", {
    passwords,
  });
}

/** A completed switch plus the modes involved, for truthful result messaging. */
export interface SwitchResultView extends SwitchCredentialStoreResult {
  targetMode: CredentialStorageMode;
  previousMode: CredentialStorageMode;
}

/**
 * Plain summary of a completed store switch, driven by the backend's
 * structured `status` (#2839) — never inferred from the free-text warnings. A
 * partial or failed switch must not read as a clean success. A failed switch
 * was rolled back, so it says nothing changed; a switch to `none` removes the
 * passwords, so it says "removed", never "moved" (#3323). The words are the
 * ones the user saw on the cards (#5837): no internal mode names, no
 * "migrated".
 */
export function switchResultSummary(view: SwitchResultView): string {
  const { status, migratedCount, removedCount, failedCount, targetMode, previousMode } = view;
  const previous = storagePlace(previousMode);
  if (targetMode === "none") {
    const total = removedCount + failedCount;
    switch (status) {
      case "partial":
        return tf("credentialSwitch.result.stopped.partial", {
          removed: removedCount,
          total,
          failed: savedPasswords(failedCount),
          previous,
        });
      case "failed":
        return tf("credentialSwitch.result.stopped.failed", {
          passwords: savedPasswords(failedCount),
          previous,
        });
      case "success":
      default:
        return removedCount === 0
          ? t("credentialSwitch.result.stopped")
          : tf("credentialSwitch.result.stopped.removed", {
              passwords: savedPasswords(removedCount),
            });
    }
  }
  const target = storagePlace(targetMode);
  const toKeychain = targetMode === "os_keychain";
  const total = migratedCount + failedCount;
  switch (status) {
    case "partial":
      return tf("credentialSwitch.result.moved.partial", {
        moved: migratedCount,
        total,
        target,
        failed: savedPasswords(failedCount),
        previous,
      });
    case "failed":
      return tf("credentialSwitch.result.moved.failed", {
        passwords: savedPasswords(failedCount),
        target,
        previous,
      });
    case "success":
    default:
      if (migratedCount === 0 || previousMode === "none") {
        return t(
          toKeychain
            ? "credentialSwitch.result.using.keychain"
            : "credentialSwitch.result.using.vault"
        );
      }
      return tf(
        toKeychain
          ? "credentialSwitch.result.moved.toKeychain"
          : "credentialSwitch.result.moved.toVault",
        { passwords: savedPasswords(migratedCount) }
      );
  }
}

/** Heading over the entries a switch to `none` could not remove. */
export function remainingTitle(previousMode: CredentialStorageMode): string {
  return tf("credentialSwitch.result.remaining.title", { previous: storagePlace(previousMode) });
}

/** How long a clean success stays before it fades (#5837). */
export const SWITCH_RESULT_VISIBLE_MS = 6000;
/** Length of the fade itself; matches `--transition-slow`. */
export const SWITCH_RESULT_FADE_MS = 400;
