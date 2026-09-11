import { useEffect, useMemo, useState } from "react";
import { Modal, Button, Input, Checkbox } from "@/components/ui";
import type { FileEntry } from "@/types/connection";
import {
  parsePermissionString,
  modeToOctalString,
  parseOctalString,
  modeToTriple,
  tripleToMode,
  formatPermissionString,
  type PermissionClass,
  type PermissionTriple,
} from "@/utils/filePermissions";

interface PermissionsDialogProps {
  /** The file/directory whose permissions are being edited, or `null` when closed. */
  entry: FileEntry | null;
  /** Apply the chosen numeric mode (low 12 bits). Rejects surface as a toast in the caller. */
  onApply: (entry: FileEntry, mode: number) => Promise<void>;
  /** Close the dialog without applying. */
  onClose: () => void;
}

const CLASSES: Array<{ key: keyof PermissionTriple; label: string }> = [
  { key: "owner", label: "Owner" },
  { key: "group", label: "Group" },
  { key: "other", label: "Other" },
];

const PERMS: Array<{ key: keyof PermissionClass; label: string }> = [
  { key: "read", label: "Read" },
  { key: "write", label: "Write" },
  { key: "execute", label: "Execute" },
];

/**
 * A small chmod editor: an owner/group/other × read/write/execute checkbox grid
 * kept in sync with an octal input. Pre-fills from the row's current `rwx`
 * permission string and applies the resulting numeric mode via {@link onApply}.
 */
export function PermissionsDialog({ entry, onApply, onClose }: PermissionsDialogProps) {
  const initialMode = useMemo(
    () => (entry?.permissions ? (parsePermissionString(entry.permissions) ?? 0) : 0),
    [entry]
  );

  const [mode, setMode] = useState(initialMode);
  const [octalText, setOctalText] = useState(modeToOctalString(initialMode));
  const [octalError, setOctalError] = useState(false);

  // Re-seed whenever the target entry changes (a new dialog open).
  useEffect(() => {
    setMode(initialMode);
    setOctalText(modeToOctalString(initialMode));
    setOctalError(false);
  }, [initialMode, entry]);

  const triple = modeToTriple(mode);

  const setBit = (cls: keyof PermissionTriple, perm: keyof PermissionClass, value: boolean) => {
    const next = { ...triple, [cls]: { ...triple[cls], [perm]: value } };
    const nextMode = tripleToMode(next);
    setMode(nextMode);
    setOctalText(modeToOctalString(nextMode));
    setOctalError(false);
  };

  const onOctalChange = (text: string) => {
    setOctalText(text);
    const parsed = parseOctalString(text);
    if (parsed === null) {
      setOctalError(true);
    } else {
      setOctalError(false);
      setMode(parsed);
    }
  };

  // Returned promise drives the Apply button's async pending lifecycle. Errors
  // propagate so the caller's `onApply` surfaces the toast and the dialog stays
  // open; on success the dialog closes.
  const handleApply = async () => {
    if (!entry || octalError) return;
    await onApply(entry, mode);
    onClose();
  };

  return (
    <Modal
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Change Permissions"
      description={entry ? `Change permissions for ${entry.name}` : undefined}
      data-testid="permissions-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="permissions-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={octalError}
            errorToast={false}
            data-testid="permissions-apply"
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="permissions-dialog">
        <p className="permissions-dialog__target" title={entry?.path}>
          {entry?.name}
        </p>

        <table className="permissions-dialog__grid" data-testid="permissions-grid">
          <thead>
            <tr>
              <th />
              {PERMS.map((p) => (
                <th key={p.key} scope="col">
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CLASSES.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                {PERMS.map((p) => {
                  const id = `perm-${c.key}-${p.key}`;
                  return (
                    <td key={p.key}>
                      <Checkbox
                        id={id}
                        checked={triple[c.key][p.key]}
                        onCheckedChange={(value) => setBit(c.key, p.key, value)}
                        aria-label={`${c.label} ${p.label}`}
                        data-testid={id}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="permissions-dialog__octal">
          <label htmlFor="permissions-octal">Octal</label>
          <Input
            id="permissions-octal"
            size="sm"
            value={octalText}
            error={octalError}
            spellCheck={false}
            inputMode="numeric"
            maxLength={4}
            onChange={(e) => onOctalChange(e.target.value)}
            data-testid="permissions-octal"
            aria-label="Octal permissions"
          />
          <span className="permissions-dialog__preview" data-testid="permissions-preview">
            {formatPermissionString(mode)}
          </span>
        </div>
      </div>
    </Modal>
  );
}
