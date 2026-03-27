import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { EmbeddedServerConfig, ServerType, DEFAULT_PORTS } from "@/types/embeddedServer";

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

  useEffect(() => {
    if (open) {
      setForm(config ? { ...config } : defaultConfig());
      setLanWarning(false);
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

  const handleLanToggle = (checked: boolean) => {
    if (checked) {
      setLanWarning(true);
    } else {
      set("bindHost", "127.0.0.1");
    }
  };

  const handleLanConfirm = () => {
    setForm((f) => ({ ...f, bindHost: "0.0.0.0" }));
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
      <Dialog.Root open={lanWarning} onOpenChange={setLanWarning}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog__overlay" />
          <Dialog.Content className="dialog__content dialog__content--sm">
            <Dialog.Title className="dialog__title">
              <AlertTriangle size={16} style={{ color: "var(--color-warning)" }} />
              Security Warning
            </Dialog.Title>
            <p className="dialog__body">
              Binding to <strong>0.0.0.0</strong> will make this server accessible to{" "}
              <strong>all devices on your network</strong>. Only enable this on trusted networks.
            </p>
            <div className="dialog__actions">
              <button
                className="btn btn--secondary"
                onClick={() => setLanWarning(false)}
                data-testid="lan-warning-cancel"
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={handleLanConfirm}
                data-testid="lan-warning-confirm"
              >
                I Understand
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Main configuration dialog */}
      <Dialog.Root open={open && !lanWarning} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog__overlay" />
          <Dialog.Content className="dialog__content">
            <Dialog.Title className="dialog__title">
              {config ? "Edit Service" : "New Service"}
            </Dialog.Title>

            <div className="server-dialog__form">
              {/* Name */}
              <label className="server-dialog__label">
                Name
                <input
                  className="server-dialog__input"
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
                <input
                  className="server-dialog__input"
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
                    <input
                      className="server-dialog__input"
                      value={form.bindHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}
                      readOnly
                      tabIndex={-1}
                      data-testid="server-dialog-bind-host"
                    />
                  </label>
                  <label className="server-dialog__label server-dialog__label--inline">
                    Port
                    <input
                      className="server-dialog__input server-dialog__input--port"
                      type="number"
                      min={1}
                      max={65535}
                      value={form.port}
                      onChange={(e) => set("port", parseInt(e.target.value, 10) || form.port)}
                      data-testid="server-dialog-port"
                    />
                  </label>
                </div>
                <label className="server-dialog__check">
                  <input
                    type="checkbox"
                    checked={form.bindHost === "0.0.0.0"}
                    onChange={(e) => handleLanToggle(e.target.checked)}
                    data-testid="server-dialog-lan"
                  />
                  Expose to LAN (bind 0.0.0.0)
                </label>
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
                        <input
                          className="server-dialog__input"
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
                        <input
                          className="server-dialog__input"
                          type="password"
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

            <div className="dialog__actions">
              <button
                className="btn btn--secondary"
                onClick={() => onOpenChange(false)}
                data-testid="server-dialog-cancel"
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={handleSubmit}
                disabled={!form.name.trim() || !form.rootDirectory.trim()}
                data-testid="server-dialog-save"
              >
                Save
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
