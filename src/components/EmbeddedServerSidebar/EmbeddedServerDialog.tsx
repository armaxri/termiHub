import { useState, useEffect } from "react";
import "./EmbeddedServerSidebar.css";
import { AlertTriangle } from "lucide-react";
import { Modal, Button, Input, NumberInput, Select, Checkbox, RadioGroup } from "@/components/ui";
import {
  EmbeddedServerConfig,
  NetworkInterface,
  ServerType,
  DEFAULT_PORTS,
} from "@/types/embeddedServer";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing config to edit, or null for a new server. */
  config: EmbeddedServerConfig | null;
  /**
   * Persist the config. Resolve `true` when the save succeeded (the dialog
   * closes) or `false` on failure (the dialog stays open so the user can retry).
   */
  onSave: (config: EmbeddedServerConfig) => boolean | Promise<boolean>;
}

/**
 * Editing shape of {@link EmbeddedServerConfig}. `port` widens to `number | ""`
 * so a cleared port field reads blank (and blocks Save) instead of silently
 * snapping back to the previous value; it is narrowed back to a number on save.
 */
type ServerFormState = Omit<EmbeddedServerConfig, "port"> & { port: number | "" };

/** Blank default config used when creating a new server. */
function defaultConfig(): ServerFormState {
  return {
    id: "",
    name: "",
    serverType: "http",
    rootDirectory: "",
    bindHost: "127.0.0.1",
    port: DEFAULT_PORTS.http,
    autoStart: false,
    readOnly: false,
    directoryListing: true,
    ftpAuth: undefined,
  };
}

/**
 * Create / edit dialog for an embedded server configuration.
 */
export function EmbeddedServerDialog({ open, onOpenChange, config, onSave }: Props) {
  const [form, setForm] = useState<ServerFormState>(defaultConfig());
  const [lanWarning, setLanWarning] = useState(false);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([
    { name: "Loopback", addr: "127.0.0.1" },
    { name: "All Interfaces", addr: "0.0.0.0" },
  ]);

  useEffect(() => {
    if (open) {
      setForm(config ? { ...config } : defaultConfig());
      setLanWarning(false);
      listNetworkInterfaces()
        .then(setInterfaces)
        .catch(() => {
          /* keep defaults on error */
        });
    }
  }, [open, config]);

  const set = <K extends keyof ServerFormState>(key: K, value: ServerFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleProtocolChange = (type: ServerType) => {
    setForm((f) => ({
      ...f,
      serverType: type,
      port: DEFAULT_PORTS[type],
      directoryListing: type === "http" ? (f.directoryListing ?? true) : undefined,
      ftpAuth: type === "ftp" ? (f.ftpAuth ?? { type: "anonymous" }) : undefined,
    }));
  };

  const handleBindHostChange = (addr: string) => {
    if (addr === "0.0.0.0") {
      setLanWarning(true);
    } else {
      set("bindHost", addr);
    }
  };

  const handleLanConfirm = () => {
    setForm((f) => ({ ...f, bindHost: "0.0.0.0" }));
    setLanWarning(false);
  };

  const handleLanCancel = () => {
    setLanWarning(false);
  };

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.rootDirectory.trim() || form.port === "") return;
    // Close only when the save actually succeeded; on failure the dialog stays
    // open (the sidebar surfaces the error via toast) so the user can retry.
    const saved = await onSave({ ...form, port: form.port });
    if (saved) onOpenChange(false);
  };

  const ftpAnon = !form.ftpAuth || form.ftpAuth.type === "anonymous";
  const ftpCreds: { username: string; password: string } =
    form.ftpAuth?.type === "credentials"
      ? { username: form.ftpAuth.username, password: form.ftpAuth.password }
      : { username: "", password: "" };

  return (
    <>
      {/* LAN exposure warning */}
      <Modal
        open={lanWarning}
        onOpenChange={setLanWarning}
        title={
          <>
            <AlertTriangle size={16} style={{ color: "var(--color-warning)" }} />
            Security Warning
          </>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleLanCancel} data-testid="lan-warning-cancel">
              Cancel
            </Button>
            <Button variant="primary" onClick={handleLanConfirm} data-testid="lan-warning-confirm">
              I Understand
            </Button>
          </>
        }
      >
        <p className="dialog__body">
          Binding to <strong>0.0.0.0</strong> will make this server accessible to{" "}
          <strong>all devices on your network</strong>. Only enable this on trusted networks.
        </p>
      </Modal>

      {/* Main configuration dialog */}
      <Modal
        open={open && !lanWarning}
        onOpenChange={onOpenChange}
        title={config ? "Edit Service" : "New Service"}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => onOpenChange(false)}
              data-testid="server-dialog-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!form.name.trim() || !form.rootDirectory.trim() || form.port === ""}
              data-testid="server-dialog-save"
            >
              Save
            </Button>
          </>
        }
      >
        <div className="server-dialog__form">
          {/* Name */}
          <label className="server-dialog__label">
            Name
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Firmware Share"
              data-testid="server-dialog-name"
              autoFocus
            />
          </label>

          {/* Protocol */}
          <div className="server-dialog__label">
            <span id="server-dialog-protocol-label">Protocol</span>
            <RadioGroup
              className="server-dialog__radio-group"
              orientation="horizontal"
              value={form.serverType}
              onValueChange={(v) => handleProtocolChange(v as ServerType)}
              aria-labelledby="server-dialog-protocol-label"
              options={(["http", "ftp", "tftp"] as ServerType[]).map((type) => ({
                value: type,
                label: type.toUpperCase(),
                "data-testid": `server-dialog-proto-${type}`,
              }))}
            />
          </div>

          {/* Root directory */}
          <label className="server-dialog__label">
            Root Directory
            <Input
              value={form.rootDirectory}
              onChange={(e) => set("rootDirectory", e.target.value)}
              placeholder="/path/to/directory"
              data-testid="server-dialog-root"
            />
          </label>

          {/* Network */}
          <fieldset className="server-dialog__fieldset">
            <legend className="server-dialog__legend">Network</legend>
            <div className="server-dialog__row">
              <label className="server-dialog__label server-dialog__label--inline">
                Bind Address
                <Select
                  value={form.bindHost}
                  onChange={handleBindHostChange}
                  options={interfaces.map((iface) => ({
                    value: iface.addr,
                    label:
                      iface.addr === "0.0.0.0" || iface.addr === "127.0.0.1"
                        ? `${iface.addr} — ${iface.name}`
                        : `${iface.addr} (${iface.name})`,
                  }))}
                  aria-label="Bind Address"
                  data-testid="server-dialog-bind-host"
                />
              </label>
              <label className="server-dialog__label server-dialog__label--inline">
                Port
                <NumberInput
                  className="server-dialog__input--port"
                  min={1}
                  max={65535}
                  value={form.port}
                  onValueChange={(v) => set("port", v)}
                  data-testid="server-dialog-port"
                />
              </label>
            </div>
          </fieldset>

          {/* Options */}
          <fieldset className="server-dialog__fieldset">
            <legend className="server-dialog__legend">Options</legend>
            <label className="server-dialog__check">
              <Checkbox
                checked={form.autoStart}
                onCheckedChange={(checked) => set("autoStart", checked)}
                aria-label="Auto-start when termiHub launches"
                data-testid="server-dialog-autostart"
              />
              <span>Auto-start when termiHub launches</span>
            </label>
            <label className="server-dialog__check">
              <Checkbox
                checked={form.readOnly}
                onCheckedChange={(checked) => set("readOnly", checked)}
                aria-label="Read-only (disable uploads / writes)"
                data-testid="server-dialog-readonly"
              />
              <span>Read-only (disable uploads / writes)</span>
            </label>
            {form.serverType === "http" && (
              <label className="server-dialog__check">
                <Checkbox
                  checked={form.directoryListing ?? false}
                  onCheckedChange={(checked) => set("directoryListing", checked)}
                  aria-label="Allow directory listing"
                  data-testid="server-dialog-dirlisting"
                />
                <span>Allow directory listing</span>
              </label>
            )}
          </fieldset>

          {/* FTP auth */}
          {form.serverType === "ftp" && (
            <fieldset className="server-dialog__fieldset">
              <legend className="server-dialog__legend">Authentication</legend>
              <RadioGroup
                value={ftpAnon ? "anonymous" : "credentials"}
                onValueChange={(v) =>
                  set(
                    "ftpAuth",
                    v === "anonymous"
                      ? { type: "anonymous" }
                      : {
                          type: "credentials",
                          username: ftpCreds.username,
                          password: ftpCreds.password,
                        }
                  )
                }
                aria-label="FTP authentication"
                options={[
                  {
                    value: "anonymous",
                    label: "Anonymous access",
                    "data-testid": "server-dialog-ftp-anon",
                  },
                  {
                    value: "credentials",
                    label: "Username / Password",
                    "data-testid": "server-dialog-ftp-creds",
                  },
                ]}
              />
              {!ftpAnon && (
                <div className="server-dialog__creds">
                  <label className="server-dialog__label">
                    Username
                    <Input
                      value={ftpCreds.username}
                      onChange={(e) => {
                        const u = e.target.value;
                        set("ftpAuth", {
                          type: "credentials",
                          username: u,
                          password: ftpCreds.password,
                        });
                      }}
                      data-testid="server-dialog-ftp-username"
                    />
                  </label>
                  <label className="server-dialog__label">
                    Password
                    <PasswordInput
                      className="server-dialog__input"
                      value={ftpCreds.password}
                      onChange={(e) => {
                        const p = e.target.value;
                        set("ftpAuth", {
                          type: "credentials",
                          username: ftpCreds.username,
                          password: p,
                        });
                      }}
                      data-testid="server-dialog-ftp-password"
                    />
                  </label>
                </div>
              )}
            </fieldset>
          )}
        </div>
      </Modal>
    </>
  );
}
