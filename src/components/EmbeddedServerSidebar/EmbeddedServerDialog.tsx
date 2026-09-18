import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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

/**
 * Client-side validation schema (UX gate only; the same checks the dialog
 * previously ran by hand, translated 1:1 into zod):
 *
 * - `name` must be non-empty once trimmed.
 * - `rootDirectory` must be non-empty once trimmed.
 * - `port` must not be blank (a cleared field is `""`).
 *
 * The schema mirrors the full {@link ServerFormState} shape so the resolver's
 * value type matches the form's; only `name`, `rootDirectory` and `port` are
 * actually gated — the remaining fields ride along and are preserved on save.
 */
const ftpAuthSchema = z.union([
  z.object({ type: z.literal("anonymous") }),
  z.object({ type: z.literal("credentials"), username: z.string(), password: z.string() }),
]);

const serverFormSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    serverType: z.enum(["http", "ftp", "tftp"]),
    rootDirectory: z.string(),
    bindHost: z.string(),
    port: z.union([z.number(), z.literal("")]),
    autoStart: z.boolean(),
    readOnly: z.boolean(),
    directoryListing: z.boolean().optional(),
    ftpAuth: ftpAuthSchema.optional(),
    maxTransferBytes: z.number().optional(),
  })
  .superRefine((form, ctx) => {
    if (form.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
    if (form.rootDirectory.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["rootDirectory"],
        message: "Root directory is required.",
      });
    }
    if (form.port === "") {
      ctx.addIssue({ code: "custom", path: ["port"], message: "Port is required." });
    }
  });

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
 *
 * Backed by react-hook-form + zod (see {@link serverFormSchema}). Validity is
 * derived synchronously from the schema so Save re-gates on the same render as
 * an edit; the protocol switch, LAN-bind confirmation, and FTP-auth union are
 * driven imperatively through `setValue` because they touch several fields at
 * once, matching the previous hand-rolled behavior exactly.
 */
export function EmbeddedServerDialog({ open, onOpenChange, config, onSave }: Props) {
  const [lanWarning, setLanWarning] = useState(false);
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([
    { name: "Loopback", addr: "127.0.0.1" },
    { name: "All Interfaces", addr: "0.0.0.0" },
  ]);

  const { control, getValues, setValue, reset } = useForm<ServerFormState>({
    defaultValues: config ? { ...config } : defaultConfig(),
    resolver: zodResolver(serverFormSchema),
    mode: "onChange",
  });

  // Reload the working copy each time the dialog opens so a prior edit never
  // leaks in and the network-interface list refreshes.
  useEffect(() => {
    if (open) {
      reset(config ? { ...config } : defaultConfig());
      setLanWarning(false);
      listNetworkInterfaces()
        .then(setInterfaces)
        .catch(() => {
          /* keep defaults on error */
        });
    }
  }, [open, config, reset]);

  // Subscribe to every field so validity + derived reads re-run on each edit,
  // then take a complete, fresh snapshot from `getValues()` (which reflects
  // `setValue` synchronously) for the schema check.
  useWatch({ control });
  const form = getValues();

  // Deterministic, synchronous validity derived straight from the schema — the
  // same approach ConnectionSettingsForm / CustomRuleEditor use — so the Save
  // gate updates on the same render as the edit (and stays testable without
  // awaiting react-hook-form's async error proxy).
  const canSave = useMemo(
    () => serverFormSchema.safeParse(form).success,
    // `form` is a fresh snapshot every render; key on its serialization so the
    // check only recomputes when a value actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(form)]
  );

  const handleProtocolChange = (type: ServerType) => {
    const cur = getValues();
    setValue("serverType", type);
    setValue("port", DEFAULT_PORTS[type]);
    setValue("directoryListing", type === "http" ? (cur.directoryListing ?? true) : undefined);
    setValue("ftpAuth", type === "ftp" ? (cur.ftpAuth ?? { type: "anonymous" }) : undefined);
  };

  const handleBindHostChange = (addr: string) => {
    if (addr === "0.0.0.0") {
      setLanWarning(true);
    } else {
      setValue("bindHost", addr);
    }
  };

  const handleLanConfirm = () => {
    setValue("bindHost", "0.0.0.0");
    setLanWarning(false);
  };

  const handleLanCancel = () => {
    setLanWarning(false);
  };

  const handleSubmit = async () => {
    const values = getValues();
    if (!canSave || values.port === "") return;
    // Close only when the save actually succeeded; on failure the dialog stays
    // open (the sidebar surfaces the error via toast) so the user can retry.
    const saved = await onSave({ ...values, port: values.port });
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
              disabled={!canSave}
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
            <Controller
              name="name"
              control={control}
              render={({ field }) => (
                <Input
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={field.onBlur}
                  placeholder="e.g. Firmware Share"
                  data-testid="server-dialog-name"
                  autoFocus
                />
              )}
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
            <Controller
              name="rootDirectory"
              control={control}
              render={({ field }) => (
                <Input
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={field.onBlur}
                  placeholder="/path/to/directory"
                  data-testid="server-dialog-root"
                />
              )}
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
                <Controller
                  name="port"
                  control={control}
                  render={({ field }) => (
                    <NumberInput
                      className="server-dialog__input--port"
                      min={1}
                      max={65535}
                      value={field.value}
                      onValueChange={field.onChange}
                      data-testid="server-dialog-port"
                    />
                  )}
                />
              </label>
            </div>
          </fieldset>

          {/* Options */}
          <fieldset className="server-dialog__fieldset">
            <legend className="server-dialog__legend">Options</legend>
            <label className="server-dialog__check">
              <Controller
                name="autoStart"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked)}
                    aria-label="Auto-start when termiHub launches"
                    data-testid="server-dialog-autostart"
                  />
                )}
              />
              <span>Auto-start when termiHub launches</span>
            </label>
            <label className="server-dialog__check">
              <Controller
                name="readOnly"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked)}
                    aria-label="Read-only (disable uploads / writes)"
                    data-testid="server-dialog-readonly"
                  />
                )}
              />
              <span>Read-only (disable uploads / writes)</span>
            </label>
            {form.serverType === "http" && (
              <label className="server-dialog__check">
                <Controller
                  name="directoryListing"
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      checked={field.value ?? false}
                      onCheckedChange={(checked) => field.onChange(checked)}
                      aria-label="Allow directory listing"
                      data-testid="server-dialog-dirlisting"
                    />
                  )}
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
                  setValue(
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
                        setValue("ftpAuth", {
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
                        setValue("ftpAuth", {
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
