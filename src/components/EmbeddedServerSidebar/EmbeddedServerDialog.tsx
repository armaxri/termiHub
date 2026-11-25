import { useEffect, useRef, useState } from "react";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import "./EmbeddedServerSidebar.css";
import { AlertTriangle } from "lucide-react";
import { open as openFolderDialog } from "@/services/nativeDialog";
import {
  Modal,
  Button,
  Field,
  Input,
  NumberInput,
  Select,
  Checkbox,
  RadioGroup,
} from "@/components/ui";
import {
  EmbeddedServerConfig,
  NetworkInterface,
  ServerType,
  DEFAULT_PORTS,
} from "@/types/embeddedServer";
import { listNetworkInterfaces } from "@/services/embeddedServerApi";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { frontendWarn } from "@/utils/frontendLog";
import { SHARE_TYPE_KINDS, shareTypeHelp } from "@/utils/shareTypeHelp";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import type { RemoteAgentDefinition } from "@/types/connection";
import { THIS_COMPUTER, isAgentHost } from "@/utils/runLocation";
import { sameHost, type HostChoice } from "@/utils/hostChoice";
import { t, tf } from "@/i18n/catalog";
import { errorMessage } from "@/utils/errorMessage";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing config to edit, or null for a new server. */
  config: EmbeddedServerConfig | null;
  /**
   * A copy to create (#6028): prefills a new server and asks for the password,
   * which the copy does not have.
   */
  draft?: EmbeddedServerConfig | null;
  /** Whether the edited server is running, so moving it stops it. */
  running?: boolean;
  /**
   * Persist the config and the chosen machine. Resolve `true` when the
   * save succeeded (the dialog closes) or `false` on failure (the dialog stays
   * open so the user can retry).
   */
  onSave: (config: EmbeddedServerConfig, runLocation: HostChoice) => boolean | Promise<boolean>;
  /** Agents offered as run targets in the "Run on" selector (#2191). */
  agents?: RemoteAgentDefinition[];
  /**
   * Where the server runs, as stored. Chosen here rather than on the row
   * (#5770): a row shows names, not settings.
   */
  runLocation?: HostChoice;
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

const httpAuthSchema = z.object({ username: z.string(), password: z.string() });

const serverFormSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    serverType: z.enum(["http", "ftp", "tftp"]),
    rootDirectory: z.string(),
    bindHost: z.string(),
    port: z.union([z.number(), z.literal("")]),
    autoStart: z.boolean(),
    readOnly: z.boolean(),
    directoryListing: z.boolean().optional(),
    ftpAuth: ftpAuthSchema.optional(),
    httpAuth: httpAuthSchema.optional(),
    maxTransferBytes: z.number().optional(),
    maxConcurrentSessions: z.number().optional(),
  })
  .superRefine((form, ctx) => {
    // The folder's name is taken when there is none.
    if (
      form.name.trim() === "" &&
      form.rootDirectory.trim() !== "" &&
      !folderName(form.rootDirectory)
    ) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
    if (form.rootDirectory.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["rootDirectory"],
        message: "Choose the folder to share.",
      });
    }
    if (form.port === "") {
      ctx.addIssue({ code: "custom", path: ["port"], message: "Port is required." });
    }
  });

/** The last part of a folder's path, if it has one. */
function folderName(folder: string): string | undefined {
  return folder.split(/[\\/]/).filter(Boolean).pop()?.trim() || undefined;
}

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
    httpAuth: undefined,
  };
}

/** The form's values for an existing server or a copy, else a blank one. */
function initialConfig(config: EmbeddedServerConfig | null): ServerFormState {
  return config ? { ...config } : defaultConfig();
}

/** Who can open a server, in words; the addresses are for special cases. */
function bindChoices(
  interfaces: readonly NetworkInterface[],
  current: string,
  onAgent: boolean
): { value: string; label: string }[] {
  const choices = [
    {
      value: "127.0.0.1",
      label: t(onAgent ? "server.editor.who.there" : "server.editor.who.here"),
    },
    {
      value: "0.0.0.0",
      label: t(onAgent ? "server.editor.who.anyoneThere" : "server.editor.who.network"),
    },
  ];
  // The addresses of this computer say nothing about another machine.
  const own = onAgent ? [] : interfaces;
  const addresses = [
    ...own.map((i) => ({ addr: i.addr, name: i.name })),
    { addr: current, name: "" },
  ];
  for (const { addr, name } of addresses) {
    if (choices.some((choice) => choice.value === addr)) continue;
    choices.push({
      value: addr,
      label: name
        ? tf("server.editor.who.through", { name, addr })
        : tf("server.editor.who.address", { addr }),
    });
  }
  return choices;
}

/** What Save still needs. */
function missingText(errors: Readonly<Record<string, string | undefined>>): string {
  const missing = [
    errors["rootDirectory"] && t("server.editor.missing.folder"),
    errors["name"] && t("server.editor.missing.name"),
    errors["port"] && t("server.editor.missing.port"),
  ].filter(Boolean);
  return tf("server.editor.missing", { fields: missing.join(", ") });
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
export function EmbeddedServerDialog({
  open,
  onOpenChange,
  config,
  draft = null,
  running = false,
  onSave,
  agents = [],
  runLocation = THIS_COMPUTER,
}: Props) {
  const [lanWarning, setLanWarning] = useState(false);
  const [location, setLocation] = useState<HostChoice>(runLocation);
  const locationName = isAgentHost(location)
    ? agents.find((agent) => agent.id === location.agentId)?.name
    : undefined;
  const [interfaces, setInterfaces] = useState<NetworkInterface[]>([
    { name: "Loopback", addr: "127.0.0.1" },
    { name: "All interfaces", addr: "0.0.0.0" },
  ]);

  // The shared RHF + zod scaffold (UISF2-003): `form` is a complete, stable
  // snapshot of the values (it reflects `setValue` at once), and `errors` /
  // `canSave` update on the same render as the edit.
  const {
    form: { control, getValues, setValue, reset },
    draft: form,
    errors: allErrors,
    canSave,
  } = useZodEditorForm<ServerFormState>({
    schema: serverFormSchema,
    defaultValues: initialConfig(config ?? draft),
  });
  // Errors show once the user edited a field and left it, or tried to save
  // (#5917) — a new service does not open with "Name is required." in red.
  // `canSave` still reads every error.
  const { shown: errors, rootProps, revealAndFocus, rebaseline } = useRevealOnSave(allErrors, form);

  // The stored machine, read when the dialog opens. `runLocation` is a new object
  // on every render of the sidebar and must not reset the user's choice.
  const storedLocation = useRef(runLocation);
  storedLocation.current = runLocation;

  // Reload the working copy each time the dialog opens so a prior edit never
  // leaks in and the network-interface list refreshes.
  useEffect(() => {
    if (open) {
      const initial = initialConfig(config ?? draft);
      reset(initial);
      rebaseline(initial);
      setLocation(storedLocation.current);
      setLanWarning(false);
      listNetworkInterfaces()
        .then(setInterfaces)
        .catch((err: unknown) => {
          // Keep the default bind choices; the form still works without the list.
          frontendWarn(
            "embedded_server",
            `listing network interfaces failed: ${errorMessage(err)}`
          );
        });
    }
  }, [open, config, draft, reset, rebaseline]);

  const handleProtocolChange = (type: ServerType) => {
    const cur = getValues();
    setValue("serverType", type);
    setValue("port", DEFAULT_PORTS[type]);
    setValue("directoryListing", type === "http" ? (cur.directoryListing ?? true) : undefined);
    setValue("ftpAuth", type === "ftp" ? (cur.ftpAuth ?? { type: "anonymous" }) : undefined);
    setValue("httpAuth", type === "http" ? cur.httpAuth : undefined);
  };

  const handleBindHostChange = (addr: string) => {
    if (addr === "0.0.0.0") {
      setLanWarning(true);
    } else {
      setValue("bindHost", addr);
    }
  };

  /** A server without a name is called like its folder. */
  const nameAfterFolder = (folder: string) => {
    const last = folderName(folder);
    if (last && getValues().name.trim() === "") setValue("name", last);
  };

  const chooseFolder = async () => {
    const picked = await openFolderDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setValue("rootDirectory", picked);
    nameAfterFolder(picked);
  };

  const handleLanConfirm = () => {
    setValue("bindHost", "0.0.0.0");
    setLanWarning(false);
  };

  const handleLanCancel = () => {
    setLanWarning(false);
  };

  const submit = async () => {
    const values = getValues();
    if (values.port === "") return;
    // Close only when the save actually succeeded; on failure the dialog stays
    // open (the sidebar surfaces the error via toast) so the user can retry.
    const saved = await onSave(
      {
        ...values,
        name: values.name.trim() === "" ? (folderName(values.rootDirectory) ?? "") : values.name,
        port: values.port,
        description: normalizeItemDescription(values.description),
      },
      location
    );
    if (saved) onOpenChange(false);
  };

  // Save stays reachable while invalid (aria-disabled, not disabled):
  // activating it then points at the problem instead of saving. That branch
  // stays synchronous so the Button shows no pending spinner for it.
  const handleSubmit = () => {
    if (!canSave) {
      revealAndFocus();
      return;
    }
    return submit();
  };

  const ftpAnon = !form.ftpAuth || form.ftpAuth.type === "anonymous";
  const ftpCreds: { username: string; password: string } =
    form.ftpAuth?.type === "credentials"
      ? { username: form.ftpAuth.username, password: form.ftpAuth.password }
      : { username: "", password: "" };

  // HTTP Basic auth (PROD-0035): presence of `httpAuth` is the enable flag; the
  // current (possibly empty) credentials feed the fields when enabled.
  const httpAuthEnabled = !!form.httpAuth;
  const httpCreds: { username: string; password: string } = form.httpAuth ?? {
    username: "",
    password: "",
  };

  // Saved passwords live in the credential store and are never sent back to the
  // UI (#3514): when editing a server that already has one, a blank field keeps it.
  const savedPasswordHint = "Saved \u2014 leave blank to keep";
  const ftpPasswordPlaceholder =
    config?.ftpAuth?.type === "credentials" ? savedPasswordHint : undefined;
  const httpPasswordPlaceholder = config?.httpAuth ? savedPasswordHint : undefined;

  return (
    <>
      {/* LAN exposure warning */}
      <Modal
        open={lanWarning}
        onOpenChange={setLanWarning}
        title={
          <>
            <AlertTriangle size={16} style={{ color: "var(--color-warning)" }} />
            {t("server.editor.open.title")}
          </>
        }
        footer={
          <>
            <Button variant="secondary" onClick={handleLanCancel} data-testid="lan-warning-cancel">
              Cancel
            </Button>
            <Button variant="primary" onClick={handleLanConfirm} data-testid="lan-warning-confirm">
              {t("server.editor.open.confirm")}
            </Button>
          </>
        }
      >
        <p className="dialog__body">
          {t(
            form.serverType === "http" || form.readOnly
              ? "server.editor.open.download"
              : "server.editor.open.upload"
          )}
        </p>
      </Modal>

      {/* Main configuration dialog */}
      <Modal
        open={open && !lanWarning}
        onOpenChange={onOpenChange}
        title={t(config ? "server.editor.title.edit" : "server.editor.title.new")}
        size="lg"
        footer={
          <>
            {!canSave && (
              <span className="server-dialog__missing" data-testid="server-dialog-missing">
                {missingText(allErrors)}
              </span>
            )}
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
              aria-disabled={!canSave}
              data-invalid={!canSave || undefined}
              data-testid="server-dialog-save"
            >
              Save
            </Button>
          </>
        }
      >
        <div className="server-dialog__form" {...rootProps}>
          {draft && (
            <p className="ui-field__hint" data-testid="server-dialog-copy-hint">
              {t("server.editor.copyHint")}
            </p>
          )}
          {/* Protocol */}
          <div className="server-dialog__label">
            <span id="server-dialog-protocol-label">{t("share.type.label")}</span>
            <RadioGroup
              variant="cards"
              orientation="horizontal"
              value={form.serverType}
              onValueChange={(v) => handleProtocolChange(v as ServerType)}
              aria-labelledby="server-dialog-protocol-label"
              options={SHARE_TYPE_KINDS.map((type) => {
                const help = shareTypeHelp(type, location, locationName);
                return {
                  value: type,
                  label: help.label,
                  description: `${help.fact} (${help.protocol})`,
                  help: help.lines,
                  "data-testid": `server-dialog-proto-${type}`,
                };
              })}
            />
          </div>

          {/* Folder to share */}
          <Controller
            name="rootDirectory"
            control={control}
            render={({ field }) => (
              <Field
                label={t("server.editor.folder")}
                htmlFor="server-dialog-root-input"
                error={errors["rootDirectory"]}
                hint={isAgentHost(location) ? t("server.editor.folder.there") : undefined}
                className="server-dialog__label"
              >
                {/* A fragment: the input is wired here, not the box around it. */}
                <>
                  <div className="server-dialog__folder">
                    <Input
                      id="server-dialog-root-input"
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value)}
                      onBlur={() => {
                        field.onBlur();
                        nameAfterFolder(field.value ?? "");
                      }}
                      error={Boolean(errors["rootDirectory"])}
                      aria-invalid={Boolean(errors["rootDirectory"])}
                      aria-describedby={
                        errors["rootDirectory"] ? "server-dialog-root-input-error" : undefined
                      }
                      data-testid="server-dialog-root"
                      autoFocus
                    />
                    {!isAgentHost(location) && (
                      <Button
                        variant="secondary"
                        onClick={chooseFolder}
                        data-testid="server-dialog-root-choose"
                      >
                        {t("server.editor.folder.choose")}
                      </Button>
                    )}
                  </div>
                </>
              </Field>
            )}
          />

          {/* Who can open it (#6063) */}
          <div className="server-dialog__row">
            <div className="server-dialog__label server-dialog__label--inline">
              <span id="server-dialog-bind-label">{t("server.editor.who")}</span>
              <Select
                value={form.bindHost}
                onChange={handleBindHostChange}
                options={bindChoices(interfaces, form.bindHost, isAgentHost(location))}
                aria-label={t("server.editor.who")}
                data-testid="server-dialog-bind-host"
              />
            </div>
            <Controller
              name="port"
              control={control}
              render={({ field }) => (
                <Field
                  label="Port"
                  htmlFor="server-dialog-port-input"
                  error={errors["port"]}
                  className="server-dialog__label server-dialog__label--inline"
                >
                  <NumberInput
                    id="server-dialog-port-input"
                    className="server-dialog__input--port"
                    min={1}
                    max={65535}
                    value={field.value}
                    onValueChange={field.onChange}
                    data-testid="server-dialog-port"
                  />
                </Field>
              )}
            />
          </div>

          {/* What they can do: a web server has no uploads. */}
          {form.serverType !== "http" && (
            <label className="server-dialog__check">
              <Controller
                name="readOnly"
                control={control}
                render={({ field }) => (
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked)}
                    aria-label={t("server.editor.onlyDownload")}
                    data-testid="server-dialog-readonly"
                  />
                )}
              />
              <span>{t("server.editor.onlyDownload")}</span>
            </label>
          )}

          {/* Name */}
          <Controller
            name="name"
            control={control}
            render={({ field }) => (
              <Field
                label="Name"
                htmlFor="server-dialog-name-input"
                error={errors["name"]}
                className="server-dialog__label"
              >
                <Input
                  id="server-dialog-name-input"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={field.onBlur}
                  placeholder={t("server.editor.name.placeholder")}
                  error={Boolean(errors["name"])}
                  data-testid="server-dialog-name"
                />
              </Field>
            )}
          />

          {/* Run on (#2191): this computer or an agent. */}
          <div className="server-dialog__label">
            <span id="server-dialog-runloc-label">{t("server.editor.runOn")}</span>
            <RunLocationSelect
              value={location}
              agents={agents}
              onChange={setLocation}
              aria-label={t("server.editor.runOn")}
              data-testid="server-dialog-runloc"
            />
            {running && !sameHost(location, runLocation) && (
              <p className="ui-field__hint" data-testid="server-dialog-move-hint">
                {t("service.host.moveHint")}
              </p>
            )}
          </div>

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

          {/* HTTP Basic auth (PROD-0035) */}
          {form.serverType === "http" && (
            <fieldset className="server-dialog__fieldset">
              <legend className="server-dialog__legend">Authentication</legend>
              <label className="server-dialog__check">
                <Checkbox
                  checked={httpAuthEnabled}
                  onCheckedChange={(checked) =>
                    setValue(
                      "httpAuth",
                      checked === true
                        ? { username: httpCreds.username, password: httpCreds.password }
                        : undefined
                    )
                  }
                  aria-label="Require authentication (HTTP Basic Auth)"
                  data-testid="server-dialog-http-auth-enable"
                />
                <span>Require authentication (Basic Auth)</span>
              </label>
              {httpAuthEnabled && (
                <div className="server-dialog__creds">
                  <label className="server-dialog__label">
                    Username
                    <Input
                      value={httpCreds.username}
                      onChange={(e) =>
                        setValue("httpAuth", {
                          username: e.target.value,
                          password: httpCreds.password,
                        })
                      }
                      data-testid="server-dialog-http-username"
                    />
                  </label>
                  <label className="server-dialog__label">
                    Password
                    <PasswordInput
                      className="server-dialog__input"
                      value={httpCreds.password}
                      placeholder={httpPasswordPlaceholder}
                      onChange={(e) =>
                        setValue("httpAuth", {
                          username: httpCreds.username,
                          password: e.target.value,
                        })
                      }
                      data-testid="server-dialog-http-password"
                    />
                  </label>
                </div>
              )}
            </fieldset>
          )}

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
                    label: "Username and password",
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
                      placeholder={ftpPasswordPlaceholder}
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
          {/* Description (#5770): one short line shown under the name. */}
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <Field
                label="Description (optional)"
                htmlFor="server-dialog-description-input"
                hint="One short line shown under the name in the sidebar."
                className="server-dialog__label"
              >
                <Input
                  id="server-dialog-description-input"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value)}
                  onBlur={field.onBlur}
                  maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
                  placeholder="What this service is for"
                  data-testid="server-dialog-description"
                />
              </Field>
            )}
          />
        </div>
      </Modal>
    </>
  );
}
