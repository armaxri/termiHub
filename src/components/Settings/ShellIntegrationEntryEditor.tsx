import { useEffect, useMemo, useState } from "react";
import type { SavedConnection, ShellEntry, ShellEntryVisibility } from "@/types/connection";
import { Button, Field, Input, Modal, Select, Toggle } from "@/components/ui";
import type { SelectOption } from "@/components/ui";
import { getPlatform } from "@/utils/platform";

/** Sentinel Select value for the "show the session picker" (no fixed connection) choice. */
const PICKER_VALUE = "__picker__";

/**
 * Built-in container spawn defaults, shown as placeholders so the user sees what
 * a blank field falls back to. Mirror the Rust constants in
 * `src-tauri/src/spawn/container.rs` (`DEFAULT_CONTAINER_IMAGE` /
 * `DEFAULT_MOUNT_TARGET`).
 */
const DEFAULT_CONTAINER_IMAGE = "ubuntu:22.04";
const DEFAULT_MOUNT_TARGET = "/workspace";

/** Normalize a text input to `undefined` when blank so no empty string persists. */
function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

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
    onSave({
      ...draft,
      name: draft.name.trim(),
      // Persist blank container fields as omitted rather than empty strings so
      // the entry round-trips to the same shape as one that never set them.
      containerImage: emptyToUndefined(draft.containerImage ?? ""),
      containerMount: emptyToUndefined(draft.containerMount ?? ""),
    });
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

        <div
          className="shell-integration-editor__group"
          role="group"
          aria-label="Container spawn defaults"
        >
          <span className="shell-integration-editor__group-label">Container spawn defaults</span>
          <span className="shell-integration-editor__meta">
            Used when this entry opens a new container. Leave blank to use the built-in defaults
            (image {DEFAULT_CONTAINER_IMAGE}, mount {DEFAULT_MOUNT_TARGET}). An explicit
            command-line image/mount always takes precedence.
          </span>
          <Field label="Container image" htmlFor="si-entry-container-image">
            <Input
              id="si-entry-container-image"
              value={draft.containerImage ?? ""}
              placeholder={DEFAULT_CONTAINER_IMAGE}
              data-testid="shell-integration-entry-container-image"
              onChange={(e) => setDraft((d) => ({ ...d, containerImage: e.target.value }))}
            />
          </Field>
          <Field label="Mount target" htmlFor="si-entry-container-mount">
            <Input
              id="si-entry-container-mount"
              value={draft.containerMount ?? ""}
              placeholder={DEFAULT_MOUNT_TARGET}
              data-testid="shell-integration-entry-container-mount"
              onChange={(e) => setDraft((d) => ({ ...d, containerMount: e.target.value }))}
            />
          </Field>
        </div>

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
