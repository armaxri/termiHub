import { useState } from "react";

import { Button, Field, Input, toast } from "@/components/ui";
import { saveBroadcastGroup } from "@/store/broadcastGroups";
import type { BroadcastGroup } from "@/types/terminal";
import { validateBroadcastGroupName } from "@/utils/broadcastGroups";
import { errorMessage } from "@/utils/errorMessage";

export interface BroadcastGroupSaveRowProps {
  /** Saved-connection ids of the current custom selection. */
  connectionIds: string[];
  /** Selected terminals that have no saved connection (cannot be stored). */
  unsavedCount: number;
  /** Called with the saved group once it has been persisted. */
  onSaved: (group: BroadcastGroup) => void;
}

/**
 * "Save as group" row under the broadcast custom picker (PROD-061, #3443):
 * stores the current selection's saved connections as a named, persistent
 * broadcast group. Saving under an existing name updates that group. Enter in
 * the name field saves (and is consumed, so it never starts the broadcast).
 */
export function BroadcastGroupSaveRow({
  connectionIds,
  unsavedCount,
  onSaved,
}: BroadcastGroupSaveRowProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSave = connectionIds.length > 0;

  const handleSave = async () => {
    const invalid = validateBroadcastGroupName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!canSave) return;
    try {
      const group = await saveBroadcastGroup(name, connectionIds);
      toast.success(`Saved broadcast group "${group.name}"`, {
        description: `${connectionIds.length} saved connection${connectionIds.length === 1 ? "" : "s"}`,
      });
      setName("");
      setError(null);
      onSaved(group);
    } catch (err) {
      toast.error(`Failed to save broadcast group: ${errorMessage(err)}`);
    }
  };

  const hint =
    unsavedCount > 0
      ? `${unsavedCount} selected terminal${unsavedCount === 1 ? " isn't a saved connection" : "s aren't saved connections"} and won't be stored in the group.`
      : "Groups remember saved connections, so they work again after a restart.";

  return (
    <div className="broadcast-scope-dialog__save-group" data-testid="broadcast-group-save">
      <Field
        label="Save selection as group"
        htmlFor="broadcast-group-name"
        error={error ?? undefined}
        hint={hint}
        hintVariant={unsavedCount > 0 ? "warning" : "default"}
      >
        <Input
          id="broadcast-group-name"
          value={name}
          placeholder="e.g. Web servers"
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSave();
            }
          }}
          data-testid="broadcast-group-name"
        />
      </Field>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleSave}
        disabled={!canSave}
        data-testid="broadcast-group-save-button"
      >
        Save group
      </Button>
    </div>
  );
}
