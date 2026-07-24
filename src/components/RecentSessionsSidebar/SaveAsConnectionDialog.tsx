import { useEffect, useMemo, useState } from "react";
import { Button, Field, Input, Modal, Select, toast } from "@/components/ui";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { sessionTypeBadge } from "@/utils/sessionHistoryTitle";

/** Sentinel for the "No folder" option (Radix Select forbids empty-string item values). */
const NO_FOLDER = "__no_folder__";

/** Generate a unique connection id, falling back when `crypto.randomUUID` is absent. */
function generateConnectionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read a config field as a display string, else undefined. */
function detail(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

interface SaveAsConnectionDialogProps {
  /** The history entry being promoted, or null when the dialog is closed. */
  entry: SessionHistoryEntry | null;
  /** Available folders for the folder picker. */
  folders: ConnectionFolder[];
  onOpenChange: (open: boolean) => void;
  /** Persist the new connection and mark the source entry promoted. */
  onSave: (connection: SavedConnection, dedupKey: string) => Promise<void>;
}

/**
 * Promotion dialog: pre-fills a name and folder from a history entry and, on
 * save, creates a normal saved connection (the history entry is retained and
 * flagged as promoted). Connection parameters are shown read-only — full editing
 * happens later via the connection editor.
 */
export function SaveAsConnectionDialog({
  entry,
  folders,
  onOpenChange,
  onSave,
}: SaveAsConnectionDialogProps) {
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState(NO_FOLDER);

  useEffect(() => {
    if (entry) {
      setName(entry.title);
      setFolderId(NO_FOLDER);
    }
  }, [entry]);

  const folderOptions = useMemo(
    () => [
      { value: NO_FOLDER, label: "No folder" },
      ...folders.map((f) => ({ value: f.id, label: f.name })),
    ],
    [folders]
  );

  const inner = (entry?.config.config ?? {}) as Record<string, unknown>;
  const details = entry
    ? [
        ["Type", sessionTypeBadge(entry.connectionType)],
        ["Host", detail(inner, "host") ?? detail(inner, "device") ?? detail(inner, "container")],
        ["Port", detail(inner, "port")],
        ["Username", detail(inner, "username")],
      ].filter(([, v]) => v != null)
    : [];

  const handleSave = async () => {
    if (!entry) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a name for the connection");
      return;
    }
    const connection: SavedConnection = {
      id: generateConnectionId(),
      name: trimmed,
      config: entry.config,
      folderId: folderId === NO_FOLDER ? null : folderId,
    };
    await onSave(connection, entry.dedupKey);
    onOpenChange(false);
  };

  return (
    <Modal
      open={entry !== null}
      onOpenChange={onOpenChange}
      title="Save as Connection"
      data-testid="save-as-connection-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} data-testid="save-as-connection-submit">
            Save Connection
          </Button>
        </>
      }
    >
      <Field label="Name" htmlFor="save-as-connection-name">
        <Input
          id="save-as-connection-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Connection name"
          data-testid="save-as-connection-name"
        />
      </Field>
      <Field label="Folder" htmlFor="save-as-connection-folder">
        <Select
          value={folderId}
          onChange={setFolderId}
          options={folderOptions}
          aria-label="Folder"
          data-testid="save-as-connection-folder"
        />
      </Field>
      {details.length > 0 && (
        <dl className="recent-sessions__save-details" data-testid="save-as-connection-details">
          {details.map(([label, value]) => (
            <div key={label} className="recent-sessions__save-detail">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Modal>
  );
}
