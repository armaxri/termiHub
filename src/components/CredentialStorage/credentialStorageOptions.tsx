import { KeyRound, LockKeyhole, ShieldOff, type LucideIcon } from "lucide-react";
import type { RadioGroupOption } from "@/components/ui";
import type { CredentialStorageMode } from "@/types/credential";
import { CREDENTIAL_STORAGE_CHOICES } from "@/utils/credentialStorageCopy";
import "./CredentialStorageChooser.css";

/**
 * One icon per storage mode, so each card's icon says what the option is
 * instead of repeating the same shield on all three (#5560).
 */
export const CREDENTIAL_STORAGE_ICONS: Record<CredentialStorageMode, LucideIcon> = {
  os_keychain: KeyRound,
  master_password: LockKeyhole,
  none: ShieldOff,
};

/**
 * The credential-storage radio cards, built from the one shared option list
 * ({@link CREDENTIAL_STORAGE_CHOICES}). The first-use chooser and Settings ▸
 * Security ▸ Credential storage both render these, so the two surfaces show
 * the same order, names, descriptions and Recommended badge (#5553). Only the
 * test ids differ per surface.
 */
export function credentialStorageRadioOptions(
  testIdFor: (mode: CredentialStorageMode) => string
): RadioGroupOption[] {
  return CREDENTIAL_STORAGE_CHOICES.map((option) => {
    const Icon = CREDENTIAL_STORAGE_ICONS[option.mode];
    return {
      value: option.mode,
      label: (
        <>
          <Icon
            size={14}
            aria-hidden="true"
            className="credential-storage-option__icon"
            data-testid={`${testIdFor(option.mode)}-icon`}
            data-icon={option.mode}
          />
          <span>{option.label}</span>
          {option.badge && (
            <span
              className="credential-storage-option__badge"
              data-testid={`${testIdFor(option.mode)}-badge`}
            >
              {option.badge}
            </span>
          )}
        </>
      ),
      description: option.description,
      "data-testid": testIdFor(option.mode),
    };
  });
}
