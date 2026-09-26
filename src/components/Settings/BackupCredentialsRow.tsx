import type { BackupCredentialsPreview } from "@/types/backup";
import type { VaultConflictStrategy } from "@/types/credential";
import { Checkbox, Select } from "@/components/ui";

interface BackupCredentialsRowProps {
  credentials: BackupCredentialsPreview;
  include: boolean;
  strategy: VaultConflictStrategy;
  onIncludeChange: (include: boolean) => void;
  onStrategyChange: (strategy: VaultConflictStrategy) => void;
}

/** The credentials section in the restore preview. */
export function BackupCredentialsRow({
  credentials,
  include,
  strategy,
  onIncludeChange,
  onStrategyChange,
}: BackupCredentialsRowProps) {
  const preview = credentials.preview;
  const included = credentials.available && include;
  const detail = preview
    ? [
        `${preview.totalCount} in backup`,
        `${preview.newCount} new`,
        ...(preview.conflictCount > 0 ? [`${preview.conflictCount} differ`] : []),
      ].join(" · ")
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
