import { Button } from "@/components/ui";
import { ENABLE_CREDENTIAL_STORAGE_LABEL } from "@/utils/credentialStorageCopy";
import { openCredentialStorageSetup } from "./openCredentialStorageSetup";

interface EnableCredentialStorageButtonProps {
  /** Runs before navigating — e.g. the password prompt closes itself first. */
  onBeforeOpen?: () => void;
  "data-testid"?: string;
}

/**
 * The "Enable credential storage…" link-style action shown beside a disabled
 * save checkbox while credential storage is off (#5186). Opens the storage
 * setting via {@link openCredentialStorageSetup}.
 */
export function EnableCredentialStorageButton({
  onBeforeOpen,
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
      {ENABLE_CREDENTIAL_STORAGE_LABEL}
    </Button>
  );
}
