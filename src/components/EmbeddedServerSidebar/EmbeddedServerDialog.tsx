import { useState, useEffect } from "react";
import "./EmbeddedServerSidebar.css";
import { AlertTriangle } from "lucide-react";
import { Modal, Button, Input } from "@/components/ui";
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
  onSave: (config: EmbeddedServerConfig) => void;
}

/** Blank default config used when creating a new server. */
function defaultConfig(): EmbeddedServerConfig {
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
  const [form, setForm] = useState<EmbeddedServerConfig>(defaultConfig());
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

  const set = <K extends keyof EmbeddedServerConfig>(key: K, value: EmbeddedServerConfig[K]) =>
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

  const handleSubmit = () => {
    if (!form.name.trim() || !form.rootDirectory.trim()) return;
    onSave(form);
    onOpenChange(false);
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
              disabled={!form.name.trim() || !form.rootDirectory.trim()}
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
          <label className="server-dialog__label">
            Protocol
            <div className="server-dialog__radio-group">
              {(["http", "ftp", "tftp"] as ServerType[]).map((type) => (
                <label key={type} className="server-dialog__radio">
                  <input
                    type="radio"
                    name="protocol"
                    value={type}
                    checked={form.serverType === type}
                    onChange={() => handleProtocolChange(type)}
                    data-testid={`server-dialog-proto-${type}`}
                  />
                  {type.toUpperCase()}
                </label>
              ))}
            </div>
          </label>

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
                <select
                  className="server-dialog__input"
                  value={form.bindHost}
                  onChange={(e) => handleBindHostChange(e.target.value)}
                  data-testid="server-dialog-bind-host"
                >
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.addr}`} value={iface.addr}>
                      {iface.addr === "0.0.0.0" || iface.addr === "127.0.0.1"
                        ? `${iface.addr} — ${iface.name}`
                        : `${iface.addr} (${iface.name})`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="server-dialog__label server-dialog__label--inline">
                Port
                <Input
                  className="server-dialog__input--port"
                  type="number"
                  min={1}
                  max={65535}
                  value={form.port}
                  onChange={(e) => set("port", parseInt(e.target.value, 10) || form.port)}
                  data-testid="server-dialog-port"
                />
              </label>
            </div>
          </fieldset>

          {/* Options */}
          <fieldset className="server-dialog__fieldset">
            <legend className="server-dialog__legend">Options</legend>
            <label className="server-dialog__check">
              <input
                type="checkbox"
                checked={form.autoStart}
                onChange={(e) => set("autoStart", e.target.checked)}
                data-testid="server-dialog-autostart"
              />
              Auto-start when termiHub launches
            </label>
            <label className="server-dialog__check">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => set("readOnly", e.target.checked)}
                data-testid="server-dialog-readonly"
              />
              Read-only (disable uploads / writes)
            </label>
            {form.serverType === "http" && (
              <label className="server-dialog__check">
                <input
                  type="checkbox"
                  checked={form.directoryListing ?? false}
                  onChange={(e) => set("directoryListing", e.target.checked)}
                  data-testid="server-dialog-dirlisting"
                />
                Allow directory listing
              </label>
            )}
          </fieldset>

          {/* FTP auth */}
          {form.serverType === "ftp" && (
            <fieldset className="server-dialog__fieldset">
              <legend className="server-dialog__legend">Authentication</legend>
              <label className="server-dialog__radio">
                <input
                  type="radio"
                  name="ftp-auth"
                  checked={ftpAnon}
                  onChange={() => set("ftpAuth", { type: "anonymous" })}
                  data-testid="server-dialog-ftp-anon"
                />
                Anonymous access
              </label>
              <label className="server-dialog__radio">
                <input
                  type="radio"
                  name="ftp-auth"
                  checked={!ftpAnon}
                  onChange={() =>
                    set("ftpAuth", {
                      type: "credentials",
                      username: ftpCreds.username,
                      password: ftpCreds.password,
                    })
                  }
                  data-testid="server-dialog-ftp-creds"
                />
                Username / Password
              </label>
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
