import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Field, Input, Modal, NumberInput, Select, toast } from "@/components/ui";
import { IconPickerDialog } from "@/components/ConnectionEditor/IconPickerDialog";
import { IconByName } from "@/utils/connectionIcons";
import { storeCredential } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import type { ConnectionConfig } from "@/types/terminal";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { sessionTypeBadge } from "@/utils/sessionHistoryTitle";

/** Sentinel for the "No folder" option (Radix Select forbids empty-string item values). */
const NO_FOLDER = "__no_folder__";

/** SSH auth methods offered by the editable Auth select. */
const AUTH_OPTIONS = [
  { value: "password", label: "Password" },
  { value: "key", label: "Key" },
  { value: "agent", label: "Agent" },
];

/** Generate a unique connection id, falling back when `crypto.randomUUID` is absent. */
function generateConnectionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read a config field as a string, else "". */
function str(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** The inner-config key that carries the host/device/container for a given type. */
function hostKeyFor(config: Record<string, unknown>): "host" | "device" | "container" {
  if ("device" in config) return "device";
  if ("container" in config) return "container";
  return "host";
}

const HOST_LABEL: Record<string, string> = {
  host: "Host",
  device: "Device",
  container: "Container",
};

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
 * Promotion dialog: pre-fills name, folder, icon and the connection parameters
 * (host/port/username/auth) from a history entry, lets the user edit them, and
 * on save creates a normal saved connection (the history entry is retained and
 * flagged as promoted). When "Save password to credential store" is ticked and
 * a password is entered, the secret is written to the credential store before
 * the connection itself is persisted.
 */
export function SaveAsConnectionDialog({
  entry,
  folders,
  onOpenChange,
  onSave,
}: SaveAsConnectionDialogProps) {
  const credentialStoreStatus = useAppStore((s) => s.credentialStoreStatus);
  const credentialStoreActive =
    credentialStoreStatus != null && credentialStoreStatus.mode !== "none";

  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState(NO_FOLDER);
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | "">("");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState("password");
  const [savePassword, setSavePassword] = useState(false);
  const [password, setPassword] = useState("");

  const inner = useMemo(() => (entry?.config.config ?? {}) as Record<string, unknown>, [entry]);
  const connectionType = entry?.connectionType ?? "";
  const hostKey = hostKeyFor(inner);
  const showPort = "port" in inner || connectionType === "ssh" || connectionType === "telnet";
  const showUsername = "username" in inner || connectionType === "ssh";
  const showAuth = connectionType === "ssh";

  useEffect(() => {
    if (!entry) return;
    setName(entry.title);
    setFolderId(NO_FOLDER);
    setIcon(undefined);
    setIconPickerOpen(false);
    setHost(str(inner, hostKey));
    const portStr = str(inner, "port");
    setPort(portStr === "" ? "" : Number(portStr));
    setUsername(str(inner, "username"));
    setAuthMethod(str(inner, "authMethod") || "password");
    setSavePassword(false);
    setPassword("");
  }, [entry, inner, hostKey]);

  const folderOptions = useMemo(
    () => [
      { value: NO_FOLDER, label: "No folder" },
      ...folders.map((f) => ({ value: f.id, label: f.name })),
    ],
    [folders]
  );

  const handleSave = async () => {
    if (!entry) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Enter a name for the connection");
      return;
    }

    const newInner: Record<string, unknown> = { ...inner };
    newInner[hostKey] = host.trim();
    if (showPort && port !== "") newInner.port = port;
    if (showUsername) newInner.username = username.trim();
    if (showAuth) newInner.authMethod = authMethod;
    if (savePassword) newInner.savePassword = true;

    const config: ConnectionConfig = { ...entry.config, config: newInner };
    const connection: SavedConnection = {
      id: generateConnectionId(),
      name: trimmed,
      config,
      folderId: folderId === NO_FOLDER ? null : folderId,
      icon,
    };

    // Persist the entered secret before writing the connection so a store
    // failure aborts the save rather than orphaning a connection whose
    // password never made it to the credential store.
    if (savePassword && password.trim() !== "") {
      const credentialType = authMethod === "key" ? "key_passphrase" : "password";
      try {
        await storeCredential(connection.id, credentialType, password);
      } catch (err) {
        toast.error(`Failed to save password: ${err}`);
        return;
      }
    }

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
      <Field label="Icon" htmlFor="save-as-connection-icon-picker">
        <div className="recent-sessions__save-icon-row">
          {icon && <IconByName name={icon} size={18} />}
          <Button
            id="save-as-connection-icon-picker"
            variant="secondary"
            size="sm"
            onClick={() => setIconPickerOpen(true)}
            data-testid="save-as-connection-icon-picker"
          >
            {icon ? "Change" : "Set Icon"}
          </Button>
          {icon && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIcon(undefined)}
              data-testid="save-as-connection-clear-icon"
            >
              Clear
            </Button>
          )}
        </div>
      </Field>

      <fieldset className="recent-sessions__save-fields" data-testid="save-as-connection-details">
        <legend className="recent-sessions__save-fields-legend">
          Connection details · {sessionTypeBadge(connectionType)}
        </legend>
        <Field label={HOST_LABEL[hostKey] ?? "Host"} htmlFor="save-as-connection-host">
          <Input
            id="save-as-connection-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            data-testid="save-as-connection-host"
          />
        </Field>
        {showPort && (
          <Field label="Port" htmlFor="save-as-connection-port">
            <NumberInput
              id="save-as-connection-port"
              value={port}
              onValueChange={setPort}
              data-testid="save-as-connection-port"
            />
          </Field>
        )}
        {showUsername && (
          <Field label="Username" htmlFor="save-as-connection-username">
            <Input
              id="save-as-connection-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              data-testid="save-as-connection-username"
            />
          </Field>
        )}
        {showAuth && (
          <Field label="Auth" htmlFor="save-as-connection-auth">
            <Select
              value={authMethod}
              onChange={setAuthMethod}
              options={AUTH_OPTIONS}
              aria-label="Auth"
              data-testid="save-as-connection-auth"
            />
          </Field>
        )}
      </fieldset>

      <div className="recent-sessions__save-password">
        <label className="recent-sessions__save-password-toggle">
          <Checkbox
            checked={savePassword}
            onCheckedChange={setSavePassword}
            disabled={!credentialStoreActive}
            data-testid="save-as-connection-save-password"
          />
          <span>Save password to credential store</span>
        </label>
        {savePassword && credentialStoreActive && (
          <Field label="Password" htmlFor="save-as-connection-password">
            <Input
              id="save-as-connection-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password to store"
              data-testid="save-as-connection-password"
            />
          </Field>
        )}
        {!credentialStoreActive && (
          <span className="recent-sessions__save-password-hint">
            Set up a credential store in Settings to save passwords.
          </span>
        )}
      </div>

      <IconPickerDialog
        open={iconPickerOpen}
        onOpenChange={setIconPickerOpen}
        currentIcon={icon}
        onIconChange={(i) => setIcon(i ?? undefined)}
      />
    </Modal>
  );
}
