import type { BackupCredentialsPreview } from "@/types/backup";
import type { VaultConflictStrategy } from "@/types/credential";
import { Button, Checkbox, Select } from "@/components/ui";
import {
  credentialRestoreStorageOffText,
  SET_UP_CREDENTIAL_STORAGE_LABEL,
} from "@/utils/credentialStorageCopy";

interface BackupCredentialsRowProps {
  credentials: BackupCredentialsPreview;
  include: boolean;
  strategy: VaultConflictStrategy;
  onIncludeChange: (include: boolean) => void;
  onStrategyChange: (strategy: VaultConflictStrategy) => void;
  /**
   * Set when credential storage is off (#5631): the row says the credentials
   * won't be restored and offers this inline action to set storage up.
   */
  onSetUpStorage?: () => void;
}

/**
 * The credentials section in the restore preview. With storage off it explains
 * that the credentials won't be restored and offers to set storage up (#5631).
 */
export function BackupCredentialsRow({
  credentials,
  include,
  strategy,
  onIncludeChange,
  onStrategyChange,
  onSetUpStorage,
}: BackupCredentialsRowProps) {
  const preview = credentials.preview;
  const included = credentials.available && include;
  const storageOff = !credentials.available && onSetUpStorage !== undefined;
  const detail = preview
    ? [
        `${preview.totalCount} in backup`,
        `${preview.newCount} new`,
        ...(preview.conflictCount > 0 ? [`${preview.conflictCount} differ`] : []),
      ].join(" · ")
    : storageOff
      ? credentialRestoreStorageOffText()
      : credentials.unavailableReason;
  return (
    <li className="backup-restore__row" data-testid="backup-restore-section-credentials">
      <Checkbox
        id="backup-restore-credentials"
        checked={included}
        onCheckedChange={onIncludeChange}
        disabled={!credentials.available}
        data-testid="backup-restore-include-credentials"
      />
      <div className="backup-restore__body">
        <label htmlFor="backup-restore-credentials" className="backup-restore__label">
          <span className="backup-restore__name">Credentials</span>
          <span className="backup-restore__detail" data-testid="backup-restore-credentials-detail">
            {detail}
          </span>
        </label>
        {storageOff && (
          <div className="backup-restore__controls">
            <Button
              variant="secondary"
              size="sm"
              onClick={onSetUpStorage}
              data-testid="backup-restore-setup-storage"
            >
              {SET_UP_CREDENTIAL_STORAGE_LABEL}
            </Button>
          </div>
        )}
        {included && preview && preview.conflictCount > 0 && (
          <div className="backup-restore__controls">
            <Select
              value={strategy}
              onChange={(s) => onStrategyChange(s as VaultConflictStrategy)}
              aria-label="When a credential already exists"
              data-testid="backup-restore-conflicts-credentials"
              options={[
                { value: "skip", label: "Keep mine" },
                { value: "overwrite", label: "Use backup" },
              ]}
            />
          </div>
        )}
      </div>
    </li>
  );
}
