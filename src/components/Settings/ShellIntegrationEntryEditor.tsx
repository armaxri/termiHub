import { useEffect, useMemo, useState } from "react";
import type { SavedConnection, ShellEntry, ShellEntryVisibility } from "@/types/connection";
import { Button, Field, Input, Modal, Select, Toggle } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { getPlatform } from "@/utils/platform";

/** Sentinel Select value for the "show the session picker" (no fixed connection) choice. */
const PICKER_VALUE = "__picker__";

interface ShellIntegrationEntryEditorProps {
  /** Whether the editor modal is open. */
  open: boolean;
  /** Called with the next open state (false on cancel / escape / scrim). */
  onOpenChange: (open: boolean) => void;
  /** The entry being edited (a fresh entry for the add flow). */
  entry: ShellEntry;
  /** Whether this is a new entry (affects the modal title). */
  isNew: boolean;
  /** Saved connections offered in the connection picker. */
  connections: SavedConnection[];
  /** Commit the edited entry. */
  onSave: (entry: ShellEntry) => void;
}

/**
 * Add / edit dialog for a shell-integration quick-access entry. Captures the
 * display name, the connection it opens (or the session picker), the Windows
 * context-menu visibility, and which right-click targets it appears for.
 */
export function ShellIntegrationEntryEditor({
  open,
  onOpenChange,
  entry,
  isNew,
  connections,
  onSave,
}: ShellIntegrationEntryEditorProps) {
  const [draft, setDraft] = useState<ShellEntry>(entry);

  // Re-seed the local form whenever a different entry is opened.
  useEffect(() => {
    if (open) setDraft(entry);
  }, [open, entry]);

  const connectionOptions = useMemo<SelectOption[]>(
    () => [
      { value: PICKER_VALUE, label: "Show session picker" },
      ...connections.map((c) => ({ value: c.id, label: c.name })),
    ],
    [connections]
  );

  const nameError = draft.name.trim().length === 0 ? "Name is required." : undefined;
  const isWindows = getPlatform() === "windows";

  const handleSave = () => {
    if (nameError) return;
    onSave({ ...draft, name: draft.name.trim() });
  };

  const setShowFor = (key: keyof ShellEntry["showFor"], value: boolean) =>
    setDraft((d) => ({ ...d, showFor: { ...d.showFor, [key]: value } }));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? "Add Entry" : "Edit Entry"}
      data-testid="shell-integration-entry-editor"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!!nameError}
            data-testid="shell-integration-entry-save"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="shell-integration-editor">
        <Field label="Name" htmlFor="si-entry-name" error={nameError}>
          <Input
            id="si-entry-name"
            value={draft.name}
            error={!!nameError}
            data-testid="shell-integration-entry-name"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>

        <Field label="Connection" htmlFor="si-entry-connection">
          <Select
            value={draft.connectionId ?? PICKER_VALUE}
            onChange={(value) =>
              setDraft((d) => ({
                ...d,
                connectionId: value === PICKER_VALUE ? undefined : value,
              }))
            }
            options={connectionOptions}
            aria-label="Connection"
            data-testid="shell-integration-entry-connection"
          />
        </Field>

        <Field label="Visibility (Windows only)" htmlFor="si-entry-visibility">
          <Select
            value={draft.visibility}
            onChange={(value) =>
              setDraft((d) => ({ ...d, visibility: value as ShellEntryVisibility }))
            }
            disabled={!isWindows}
            options={[
              { value: "always", label: "Always visible in context menu" },
              { value: "extended", label: "Extended menu only (Shift+Right-click)" },
            ]}
            aria-label="Visibility"
            data-testid="shell-integration-entry-visibility"
          />
        </Field>

        <div className="shell-integration-editor__group" role="group" aria-label="Show for">
          <span className="shell-integration-editor__group-label">Show for</span>
          <label className="shell-integration-editor__toggle-row">
            <Toggle
              checked={draft.showFor.folders}
              onCheckedChange={(v) => setShowFor("folders", v)}
              aria-label="Show for folders"
            />
            <span>Folders</span>
          </label>
          <label className="shell-integration-editor__toggle-row">
            <Toggle
              checked={draft.showFor.files}
              onCheckedChange={(v) => setShowFor("files", v)}
              aria-label="Show for files"
            />
            <span>
              Files <span className="shell-integration-editor__meta">(opens parent directory)</span>
            </span>
          </label>
          <label className="shell-integration-editor__toggle-row">
            <Toggle
              checked={draft.showFor.folderBackground}
              onCheckedChange={(v) => setShowFor("folderBackground", v)}
              aria-label="Show for folder background"
            />
            <span>Folder background (right-click empty space)</span>
          </label>
        </div>
      </div>
    </Modal>
  );
}
