import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PasswordInput } from "@/components/PasswordInput/PasswordInput";
import { RunLocationSelect } from "@/components/RunLocationSelect";
import {
  Button,
  Checkbox,
  Field,
  Input,
  NumberInput,
  RadioGroup,
  toast,
  UnsavedChangesDialog,
} from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useCarriedFormDraft, useFormDraftProvider } from "@/hooks/useFormDraftHandoff";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import { useServiceContext } from "@/hooks/useServiceContext";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { t, tf } from "@/i18n/catalog";
import { open as openFolderDialog } from "@/services/nativeDialog";
import { newId } from "@/services/transport/ids";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import type { ServerType } from "@/types/embeddedServer";
import type { ServerEditorMeta } from "@/types/terminal";
import { draftKey } from "@/utils/draftKey";
import { errorMessage } from "@/utils/errorMessage";
import { clearDraftSecrets } from "@/utils/formDraftSecrets";
import { frontendLog } from "@/utils/frontendLog";
import { hostChoice, sameHost } from "@/utils/hostChoice";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { isAgentHost } from "@/utils/runLocation";
import { isWideBind } from "@/utils/serviceAddress";
import { fileServerModel } from "@/utils/serviceModel";
import { isServiceActive, serverServiceState } from "@/utils/serviceState";
import { SHARE_TYPE_KINDS, shareTypeHelp } from "@/utils/shareTypeHelp";
import {
  configOf,
  fileServerSchema,
  folderName,
  formOf,
  hasSignIn,
  hasUploads,
  missingText,
  newForm,
  openWarning,
  savedSignIn,
  withType,
  type FileServerForm,
} from "./fileServerForm";
import { editorSubtitle, ServiceEditorShell, ServiceEditorWarning } from "./ServiceEditorShell";
import { freePort, portTaken, PortTakenNote, tftpPortNote } from "./PortNote";
import { WhoCanOpen } from "./WhoCanOpen";
import { useEditorTab } from "./useEditorTab";

interface FileServerEditorProps {
  tabId: string;
  meta: ServerEditorMeta;
  isVisible: boolean;
}

/** The server of which a preview tells the address. */
const PREVIEW = {
  serverId: "",
  status: "running",
  stats: { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 },
} as const;

/**
 * The editor of a file server (#6028, slice 7), as a tab: what one came for first
 * (the folder, who can open it, the port), in words. A new one starts with the safer
 * defaults; saved ones keep what they have.
 */
export function FileServerEditor({ tabId, meta, isVisible }: FileServerEditorProps) {
  const servers = useAppStore((s) => s.embeddedServers);
  const states = useAppStore((s) => s.embeddedServerStates);
  const saveEmbeddedServer = useAppStore((s) => s.saveEmbeddedServer);
  const startEmbeddedServer = useAppStore((s) => s.startEmbeddedServer);
  const restartEmbeddedServer = useAppStore((s) => s.restartEmbeddedServer);
  const { remoteAgents } = useProjectedAgents();

  const existing = meta.serverId ? servers.find(({ id }) => id === meta.serverId) : undefined;
  // A copy of one with a password, which it has to be given (#6028, F-4).
  const original = meta.copyOf ? servers.find(({ id }) => id === meta.copyOf) : undefined;
  const saved = savedSignIn(existing);
  const schema = useMemo(() => fileServerSchema(saved), [saved]);
  // The ports the services of this computer are set to (V-002).
  const { usedPorts } = useServiceContext(false);
  const free = (port: number) => freePort(port, { usedPorts });
  /** What it starts with, before anything is typed. */
  const untouched = (): FileServerForm => {
    if (existing) return formOf(existing);
    return original
      ? {
          ...formOf(original),
          name: tf("server.editor.copyName", { name: original.name }),
          autoStart: false,
        }
      : newForm(meta.serverType ?? "http", free);
  };
  // Unsaved values carried in from another window by "Move tabs" (#4500).
  const carried = useCarriedFormDraft<FileServerForm>(tabId, "server-editor");
  const {
    form: { getValues, setValue, reset },
    draft: form,
    errors: allErrors,
    canSave,
  } = useZodEditorForm<FileServerForm>({
    schema,
    defaultValues: (meta.serverId && !existing ? null : carried) ?? untouched(),
  });
  // Errors show once the user edited a field and left it, or tried to save (#5917).
  const { shown: errors, rootProps, revealAndFocus } = useRevealOnSave(allErrors, form);

  const [baseline, setBaseline] = useState(() => draftKey(untouched()));
  // A server that is published again (its state, its traffic) must not reset what
  // the user typed: it is loaded once, when it is there.
  const loadedId = useRef(existing?.id);
  useEffect(() => {
    if (!existing || loadedId.current === existing.id) return;
    loadedId.current = existing.id;
    const loaded = formOf(existing);
    reset(carried ?? loaded);
    setBaseline(draftKey(loaded));
  }, [existing, carried, reset]);

  const isDirty = draftKey(form) !== baseline;
  const tab = useEditorTab(tabId, isDirty);
  useFormDraftProvider(tabId, () => {
    if (!isDirty) return null;
    const { values, cleared } = clearDraftSecrets(getValues());
    return {
      kind: "server-editor",
      values: values as unknown as Record<string, unknown>,
      ...(cleared.length > 0 ? { clearedSecrets: cleared } : {}),
    };
  });

  const agentName = isAgentHost(form.host)
    ? remoteAgents.find((agent) => agent.id === (isAgentHost(form.host) ? form.host.agentId : ""))
        ?.name
    : undefined;
  const onAgent = isAgentHost(form.host);
  const active = isServiceActive(serverServiceState(existing && states[existing.id]?.status));
  const moves = existing !== undefined && !sameHost(form.host, hostChoice(existing.host));

  // ── What it is for ─────────────────────────────────────────────────────────
  const [choosing, setChoosing] = useState(false);
  // Whether who can open it is still what a new server of this kind starts with.
  const [presetWho, setPresetWho] = useState(!existing && !original);
  const changeType = (type: ServerType) => {
    const next = withType(getValues(), type, presetWho, free);
    for (const [key, value] of Object.entries(next)) {
      setValue(key as keyof FileServerForm, value as never);
    }
  };

  // ── The folder ─────────────────────────────────────────────────────────────
  const nameAfterFolder = (folder: string) => {
    const last = folderName(folder);
    if (last && getValues("name").trim() === "") setValue("name", last);
  };
  const chooseFolder = async () => {
    const picked = await openFolderDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setValue("rootDirectory", picked);
    nameAfterFolder(picked);
  };
  const folderRef = useRef<HTMLInputElement>(null);
  useEffect(() => folderRef.current?.focus(), []);

  // ── Who can open it ────────────────────────────────────────────────────────
  const whoLabels = onAgent
    ? {
        here: t("server.editor.who.there"),
        network: t("server.editor.who.anyoneThere"),
        address: t("server.editor.who.one.there"),
      }
    : {
        here: t("server.editor.who.here"),
        network: t(
          form.serverType === "tftp" ? "server.editor.who.devices" : "server.editor.who.network"
        ),
        address: t("server.editor.who.one.here"),
      };
  const warning = openWarning(form);

  const context = useServiceContext(isWideBind(form.bindHost));
  const taken = onAgent ? undefined : portTaken(form.port, existing?.id, context);
  const preview =
    form.bindHost.trim() !== "" && form.port !== ""
      ? fileServerModel(configOf(form, "", existing, true), PREVIEW, context).address
      : undefined;

  // ── Save ───────────────────────────────────────────────────────────────────
  const save = async (then: "close" | "run") => {
    if (!canSave) {
      revealAndFocus();
      return;
    }
    const values = getValues();
    const config = configOf(
      values,
      existing?.id ?? newId("srv"),
      existing ?? original,
      !existing || moves
    );
    config.description = normalizeItemDescription(values.description);
    try {
      await saveEmbeddedServer(config);
    } catch (err) {
      frontendLog("embedded_server", `Failed to save file server: ${errorMessage(err)}`);
      throw err instanceof Error ? err : new Error(t("server.editor.saveFailed"));
    }
    if (then === "run") {
      // Its row says why it did not start; the toast is for a closed sidebar.
      (active ? restartEmbeddedServer : startEmbeddedServer)(config.id).catch((err: unknown) => {
        frontendLog("embedded_server", `Failed to start after save: ${errorMessage(err)}`);
        toast.error(tf("server.editor.startFailed", { name: config.name }));
      });
    }
    tab.close();
  };

  const primaryRef = useRef<HTMLButtonElement>(null);
  const onKeyDown = useEditorKeyboard({
    onSubmit: () => primaryRef.current?.click(),
    onCancel: tab.cancel,
  });
  // A new one is made to be used (#5810).
  const runFirst = !existing;
  const button = (then: "close" | "run", label: string, testId: string) => {
    const primary = (then === "run") === runFirst;
    return (
      <Button
        ref={primary ? primaryRef : undefined}
        variant={primary ? "primary" : "secondary"}
        onClick={() => save(then)}
        aria-disabled={!canSave}
        data-invalid={!canSave || undefined}
        data-testid={testId}
      >
        {label}
      </Button>
    );
  };
  const saveButton = button("close", t("service.editor.save"), "server-dialog-save");
  const runButton = button(
    "run",
    t(active ? "service.editor.saveAndRestart" : "service.editor.saveAndStart"),
    "server-dialog-save-start"
  );

  const signIn = hasSignIn(form.serverType) && form.signIn;
  const text = (
    name: "name" | "description" | "username",
    label: string,
    more: { placeholder?: string; maxLength?: number; hint?: string } = {}
  ): ReactNode => {
    const { hint, ...input } = more;
    return (
      <Field label={label} htmlFor={`server-${name}-${tabId}`} error={errors[name]} hint={hint}>
        <Input
          id={`server-${name}-${tabId}`}
          value={form[name]}
          onChange={(e) => setValue(name, e.target.value)}
          error={Boolean(errors[name])}
          data-testid={`server-dialog-${name}`}
          {...input}
        />
      </Field>
    );
  };

  return (
    <ServiceEditorShell
      testId="server-editor"
      isVisible={isVisible}
      title={existing ? existing.name : t(`service.new.${form.serverType}`)}
      subtitle={editorSubtitle(!existing, t(`service.new.${form.serverType}.technical`))}
      onChangeType={choosing ? undefined : () => setChoosing(true)}
      rootProps={rootProps}
      onKeyDown={onKeyDown}
      note={
        canSave
          ? active && isDirty && !moves
            ? t("service.editor.afterRestart")
            : undefined
          : missingText(allErrors)
      }
      actions={
        <>
          <Button variant="secondary" onClick={tab.cancel} data-testid="server-dialog-cancel">
            {t("service.action.cancel")}
          </Button>
          {runFirst ? saveButton : runButton}
          {runFirst ? runButton : saveButton}
        </>
      }
    >
      {original && (
        <p className="service-editor__hint" data-testid="server-dialog-copy-hint">
          {t("server.editor.copyHint")}
        </p>
      )}
      {choosing && (
        <div className="service-editor__group">
          <span className="service-editor__label" id={`server-type-${tabId}`}>
            {t("share.type.label")}
          </span>
          <RadioGroup
            variant="cards"
            orientation="horizontal"
            value={form.serverType}
            onValueChange={(type) => changeType(type as ServerType)}
            aria-labelledby={`server-type-${tabId}`}
            options={SHARE_TYPE_KINDS.map((type) => {
              const card = shareTypeHelp(type, form.host, agentName);
              return {
                value: type,
                label: t(`service.new.${type}`),
                description: `${t(`service.new.${type}.technical`)}. ${card.fact}`,
                help: card.lines,
                "data-testid": `server-dialog-proto-${type}`,
              };
            })}
          />
        </div>
      )}

      <Field
        label={t("server.editor.folder")}
        htmlFor={`server-folder-${tabId}`}
        error={errors.rootDirectory}
        hint={onAgent ? t("server.editor.folder.there") : undefined}
      >
        {/* A fragment: the input is wired here, not the box around it. */}
        <>
          <div className="service-editor__folder">
            <Input
              ref={folderRef}
              id={`server-folder-${tabId}`}
              value={form.rootDirectory}
              onChange={(e) => setValue("rootDirectory", e.target.value)}
              onBlur={() => nameAfterFolder(getValues("rootDirectory"))}
              error={Boolean(errors.rootDirectory)}
              aria-invalid={Boolean(errors.rootDirectory)}
              aria-describedby={errors.rootDirectory ? `server-folder-${tabId}-error` : undefined}
              data-testid="server-dialog-root"
            />
            {!onAgent && (
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

      <div className="service-editor__row">
        <Field
          label={t("server.editor.runOn")}
          hint={active && moves ? t("service.host.moveHint") : undefined}
          data-testid="server-dialog-runloc-field"
        >
          <RunLocationSelect
            value={form.host}
            agents={remoteAgents}
            onChange={(host) => setValue("host", host)}
            aria-label={t("server.editor.runOn")}
            data-testid="server-dialog-runloc"
          />
        </Field>
        <Field
          label={t("server.editor.port")}
          htmlFor={`server-port-${tabId}`}
          error={errors.port}
          className="service-editor__port"
        >
          <NumberInput
            id={`server-port-${tabId}`}
            min={1}
            max={65535}
            value={form.port}
            onValueChange={(port) => setValue("port", port)}
            error={Boolean(errors.port)}
            data-testid="server-dialog-port"
          />
        </Field>
      </div>

      {taken && (
        <PortTakenNote
          testId="server-dialog"
          taken={taken}
          onUse={(port) => setValue("port", port)}
        />
      )}
      {form.serverType === "tftp" && (
        <p className="service-editor__hint" data-testid="server-dialog-tftp-port">
          {tftpPortNote(form.port, onAgent)}
        </p>
      )}

      <WhoCanOpen
        testId="server-dialog"
        id={`server-${tabId}`}
        bind={form.bindHost}
        onBind={(bind) => {
          setPresetWho(false);
          setValue("bindHost", bind);
        }}
        labels={whoLabels}
        here="127.0.0.1"
        onThisComputer={!onAgent}
        error={errors.bindHost}
      />
      {warning.length > 0 && (
        <ServiceEditorWarning testId="server-dialog-warning">
          {warning.join(" ")}
        </ServiceEditorWarning>
      )}
      {preview && (
        <p className="service-editor__sentence" data-testid="server-dialog-address-preview">
          {preview.copy ? (
            <>
              {t("server.editor.address")} <code>{preview.copy}</code> · {preview.reach}
            </>
          ) : (
            preview.reach
          )}
        </p>
      )}

      <div className="service-editor__group">
        <span className="service-editor__label" id={`server-can-${tabId}`}>
          {t("server.editor.can")}
        </span>
        {hasUploads(form.serverType) ? (
          <RadioGroup
            value={form.readOnly ? "download" : "upload"}
            onValueChange={(can) => setValue("readOnly", can === "download")}
            aria-labelledby={`server-can-${tabId}`}
            options={[
              {
                value: "download",
                label: t("server.editor.can.download"),
                "data-testid": "server-dialog-can-download",
              },
              {
                value: "upload",
                label: t("server.editor.can.upload"),
                "data-testid": "server-dialog-can-upload",
              },
            ]}
          />
        ) : (
          <label className="service-editor__check">
            <Checkbox
              checked={form.directoryListing}
              onCheckedChange={(checked) => setValue("directoryListing", checked === true)}
              aria-label={t("server.editor.listing")}
              data-testid="server-dialog-dirlisting"
            />
            <span>{t("server.editor.listing")}</span>
          </label>
        )}
        {hasSignIn(form.serverType) && (
          <label className="service-editor__check">
            <Checkbox
              checked={form.signIn}
              onCheckedChange={(checked) => setValue("signIn", checked === true)}
              aria-label={t("server.editor.askPassword")}
              data-testid="server-dialog-signin"
            />
            <span>{t("server.editor.askPassword")}</span>
          </label>
        )}
        {signIn && (
          <div className="service-editor__row service-editor__indent">
            {text("username", t("server.editor.username"))}
            <Field
              label={t("server.editor.password")}
              htmlFor={`server-password-${tabId}`}
              error={errors.password}
            >
              <PasswordInput
                id={`server-password-${tabId}`}
                value={form.password}
                placeholder={
                  saved === form.serverType ? t("server.editor.password.saved") : undefined
                }
                onChange={(e) => setValue("password", e.target.value)}
                aria-invalid={Boolean(errors.password)}
                data-testid="server-dialog-password"
              />
            </Field>
          </div>
        )}
      </div>

      {text("name", t("server.editor.name"), {
        placeholder: t("server.editor.name.placeholder"),
      })}
      {text("description", t("server.editor.description"), {
        placeholder: t("server.editor.description.placeholder"),
        maxLength: ITEM_DESCRIPTION_MAX_LENGTH,
      })}

      <label className="service-editor__check">
        <Checkbox
          checked={form.autoStart}
          onCheckedChange={(checked) => setValue("autoStart", checked === true)}
          aria-label={t("server.editor.autoStart")}
          data-testid="server-dialog-autostart"
        />
        <span>{t("server.editor.autoStart")}</span>
      </label>

      <UnsavedChangesDialog
        open={tab.asking}
        subject="file server"
        name={form.name.trim() || undefined}
        onCancel={tab.stopAsking}
        onJustClose={() => {
          tab.stopAsking();
          tab.close();
        }}
        onSaveAndClose={
          canSave
            ? async () => {
                await save("close");
                tab.stopAsking();
              }
            : undefined
        }
      />
    </ServiceEditorShell>
  );
}
