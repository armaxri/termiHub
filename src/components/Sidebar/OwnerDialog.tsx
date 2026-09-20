import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@/components/ui";
import type { FileEntry } from "@/types/connection";

interface OwnerDialogProps {
  /** The file/directory whose owner is being changed, or `null` when closed. */
  entry: FileEntry | null;
  /**
   * Apply the chosen owner. A `null` uid/gid leaves that side unchanged. Rejects
   * surface as a toast in the caller (which re-throws so the dialog stays open).
   */
  onApply: (entry: FileEntry, uid: number | null, gid: number | null) => Promise<void>;
  /** Close the dialog without applying. */
  onClose: () => void;
}

/**
 * Parse a numeric-id field: empty → `null` (leave that id unchanged); a
 * non-negative safe integer → that id; anything else → invalid.
 */
function parseId(text: string): { value: number | null; error: boolean } {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null, error: false };
  if (!/^\d+$/.test(trimmed)) return { value: null, error: true };
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return { value: null, error: true };
  return { value: n, error: false };
}

/**
 * A small chown editor: numeric uid/gid inputs, each blank-to-keep-unchanged.
 * Applies the resulting owner via {@link onApply}. Only offered by backends that
 * support ownership changes (SFTP-backed sessions or a local Unix host).
 */
export function OwnerDialog({ entry, onApply, onClose }: OwnerDialogProps) {
  const [uidText, setUidText] = useState("");
  const [gidText, setGidText] = useState("");

  // Re-seed (clear) whenever the target entry changes (a new dialog open).
  useEffect(() => {
    setUidText("");
    setGidText("");
  }, [entry]);

  const uid = parseId(uidText);
  const gid = parseId(gidText);
  const hasError = uid.error || gid.error;
  // With both fields blank there is nothing to change, so disable Apply.
  const nothingToChange = uid.value === null && gid.value === null;

  // Returned promise drives the Apply button's async pending lifecycle. Errors
  // propagate so the caller's `onApply` surfaces the toast and the dialog stays
  // open; on success the dialog closes.
  const handleApply = async () => {
    if (!entry || hasError || nothingToChange) return;
    await onApply(entry, uid.value, gid.value);
    onClose();
  };

  return (
    <Modal
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Change Owner"
      description={entry ? `Change owner of ${entry.name}` : undefined}
      data-testid="owner-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="owner-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={hasError || nothingToChange}
            errorToast={false}
            data-testid="owner-apply"
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="owner-dialog">
        <p className="owner-dialog__target" title={entry?.path}>
          {entry?.name}
        </p>
        <p className="owner-dialog__hint">Leave a field blank to keep it unchanged.</p>

        <div className="owner-dialog__field">
          <label htmlFor="owner-uid">User ID (uid)</label>
          <Input
            id="owner-uid"
            size="sm"
            value={uidText}
            error={uid.error}
            spellCheck={false}
            inputMode="numeric"
            placeholder="unchanged"
            onChange={(e) => setUidText(e.target.value)}
            data-testid="owner-uid"
            aria-label="User ID"
          />
        </div>

        <div className="owner-dialog__field">
          <label htmlFor="owner-gid">Group ID (gid)</label>
          <Input
            id="owner-gid"
            size="sm"
            value={gidText}
            error={gid.error}
            spellCheck={false}
            inputMode="numeric"
            placeholder="unchanged"
            onChange={(e) => setGidText(e.target.value)}
            data-testid="owner-gid"
            aria-label="Group ID"
          />
        </div>
      </div>
    </Modal>
  );
}
