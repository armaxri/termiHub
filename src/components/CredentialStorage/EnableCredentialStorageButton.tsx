import { Button } from "@/components/ui";
import { ENABLE_CREDENTIAL_STORAGE_LABEL } from "@/utils/credentialStorageCopy";
import { openCredentialStorageSetup } from "./openCredentialStorageSetup";

interface EnableCredentialStorageButtonProps {
  /** Runs before navigating — e.g. the password prompt closes itself first. */
  onBeforeOpen?: () => void;
  /** The action's text; "Enable credential storage…" by default. */
  label?: string;
  "data-testid"?: string;
}

/**
 * The "Enable credential storage…" link-style action shown beside a disabled
 * save checkbox while credential storage is off (#5186). Opens the storage
 * setting via {@link openCredentialStorageSetup}.
 */
export function EnableCredentialStorageButton({
  onBeforeOpen,
  label = ENABLE_CREDENTIAL_STORAGE_LABEL,
  "data-testid": testId,
}: EnableCredentialStorageButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(e) => {
        e.preventDefault();
        onBeforeOpen?.();
        openCredentialStorageSetup();
      }}
      data-testid={testId}
    >
      {label}
    </Button>
  );
}
