import type { CredentialStorageMode } from "@/types/credential";
import { t, tf } from "@/i18n/catalog";

/** The wording of one credential-storage switch confirmation (#5629). */
export interface SwitchConfirmCopy {
  /** Dialog title naming the action. */
  title: string;
  /** What happens to the saved credentials and the master-password vault. */
  text: string;
  /** Confirm-button label naming the action (never a bare "Confirm"). */
  action: string;
  /** The switch deletes saved credentials, so the confirm is a danger action. */
  destructive: boolean;
}

/**
 * Copy for the confirmation shown before switching credential storage from
 * `from` to `to`. Each one names its action and says what happens to the saved
 * credentials and the master-password vault, matching the backend: a move
 * copies the credentials and leaves the source in place (the vault file is kept,
 * locked), and a switch to `none` deletes them from the source.
 */
export function switchConfirmCopy(
  from: CredentialStorageMode,
  to: CredentialStorageMode
): SwitchConfirmCopy {
  if (to === "none") {
    const source = t(
      from === "os_keychain"
        ? "credentialSwitch.confirm.toNone.source.keychain"
        : "credentialSwitch.confirm.toNone.source.vault"
    );
    return {
      title: t("credentialSwitch.confirm.toNone.title"),
      text: tf("credentialSwitch.confirm.toNone.text", { source }),
      action: t("credentialSwitch.confirm.toNone.action"),
      destructive: true,
    };
  }
  if (to === "os_keychain") {
    const move = from === "master_password";
    return {
      title: t(
        move
          ? "credentialSwitch.confirm.toKeychain.move.title"
          : "credentialSwitch.confirm.toKeychain.fresh.title"
      ),
      text: t(
        move
          ? "credentialSwitch.confirm.toKeychain.move.text"
          : "credentialSwitch.confirm.toKeychain.fresh.text"
      ),
      action: t(
        move
          ? "credentialSwitch.confirm.toKeychain.move.action"
          : "credentialSwitch.confirm.toKeychain.fresh.action"
      ),
      destructive: false,
    };
  }
  const move = from === "os_keychain";
  return {
    title: t(
      move
        ? "credentialSwitch.confirm.toMaster.move.title"
        : "credentialSwitch.confirm.toMaster.fresh.title"
    ),
    text: t(
      move
        ? "credentialSwitch.confirm.toMaster.move.text"
        : "credentialSwitch.confirm.toMaster.fresh.text"
    ),
    action: t(
      move
        ? "credentialSwitch.confirm.toMaster.move.action"
        : "credentialSwitch.confirm.toMaster.fresh.action"
    ),
    destructive: false,
  };
}
