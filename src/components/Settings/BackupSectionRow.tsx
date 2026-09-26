import type { BackupSectionPreview, RestoreMode } from "@/types/backup";
import type { VaultConflictStrategy } from "@/types/credential";
import { Checkbox, Select } from "@/components/ui";

/** How the user chose to restore one section. */
export interface SectionChoice {
  include: boolean;
  mode: RestoreMode;
  conflicts: VaultConflictStrategy;
}

interface BackupSectionRowProps {
  section: BackupSectionPreview;
  choice: SectionChoice | undefined;
  /** Whether the section can be restored (not newer / invalid / unknown). */
  restorable: boolean;
  onChange: (patch: Partial<SectionChoice>) => void;
}

/** One-line summary of a previewed section's items against the current store. */
export function sectionSummary(section: BackupSectionPreview): string {
  if (section.id === "settings") return "Replaces your current settings";
  const parts = [`${section.itemCount} in backup`, `${section.newCount} new`];
  if (section.conflictCount > 0) parts.push(`${section.conflictCount} differ`);
  if (section.unchangedCount > 0) parts.push(`${section.unchangedCount} unchanged`);
  return parts.join(" · ");
}

/** One section in the restore preview: include, merge/replace, conflicts. */
export function BackupSectionRow({ section, choice, restorable, onChange }: BackupSectionRowProps) {
  const id = `backup-restore-${section.id}`;
  const included = restorable && (choice?.include ?? false);
  // Trust stores always keep the current keys on a conflict: no choice to offer.
  const showConflicts =
    included &&
    choice?.mode === "merge" &&
    section.conflictCount > 0 &&
    !section.conflictsKeepExisting;
  return (
    <li className="backup-restore__row" data-testid={`backup-restore-section-${section.id}`}>
      <Checkbox
        id={id}
        checked={included}
        onCheckedChange={(include) => onChange({ include })}
        disabled={!restorable}
        data-testid={`backup-restore-include-${section.id}`}
      />
      <div className="backup-restore__body">
        <label htmlFor={id} className="backup-restore__label">
          <span className="backup-restore__name">{section.label}</span>
          <span className="backup-restore__detail">
            {restorable ? sectionSummary(section) : section.message}
            {section.status === "migrated" &&
              ` · upgraded from format v${section.schemaVersion} to v${section.supportedVersion}`}
          </span>
        </label>
        {restorable &&
          section.notes.map((note) => (
            <p
              key={note}
              className="backup-restore__detail"
              data-testid={`backup-restore-note-${section.id}`}
            >
              {note}
            </p>
          ))}
        {included && (
          <div className="backup-restore__controls">
            <Select
              value={choice?.mode}
              onChange={(mode) => onChange({ mode: mode as RestoreMode })}
              aria-label={`How to restore ${section.label}`}
              data-testid={`backup-restore-mode-${section.id}`}
              options={[
                { value: "merge", label: "Merge", disabled: !section.supportsMerge },
                { value: "replace", label: "Replace" },
              ]}
            />
            {showConflicts && (
              <Select
                value={choice?.conflicts}
                onChange={(c) => onChange({ conflicts: c as VaultConflictStrategy })}
                aria-label={`When ${section.label} already exist`}
                data-testid={`backup-restore-conflicts-${section.id}`}
                options={[
                  { value: "skip", label: "Keep mine" },
                  { value: "overwrite", label: "Use backup" },
                ]}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
