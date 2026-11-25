import { useState, useEffect, useMemo, useRef } from "react";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { z } from "zod";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { useRevealOnSave } from "@/hooks/useRevealedErrors";
import { useCarriedFormDraft, useFormDraftProvider } from "@/hooks/useFormDraftHandoff";
import { clearDraftSecrets } from "@/utils/formDraftSecrets";
import { Monitor, Server } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import type { TunnelConfig, TunnelType } from "@/types/tunnel";
import { TunnelEditorMeta } from "@/types/terminal";
import {
  Button,
  Checkbox,
  Input,
  NumberInput,
  RadioGroup,
  type RadioGroupOption,
  Select,
  Field,
  UnsavedChangesDialog,
  toast,
} from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useServiceContext } from "@/hooks/useServiceContext";
import {
  editorSubtitle,
  ServiceEditorShell,
  ServiceEditorWarning,
} from "@/components/ServiceEditor/ServiceEditorShell";
import { useEditorTab } from "@/components/ServiceEditor/useEditorTab";
import { WhoCanOpen } from "@/components/ServiceEditor/WhoCanOpen";
import { isWideBind } from "@/utils/serviceAddress";
import { tunnelModel } from "@/utils/serviceModel";
import { frontendLog } from "@/utils/frontendLog";
import {
  isAgentHost,
  tunnelHostMachine,
  tunnelEndpointLines,
  tunnelReachabilityWarning,
  WIDE_BIND_HOST,
} from "@/utils/tunnelHost";
import { isServiceActive, tunnelServiceState } from "@/utils/serviceState";
import { tunnelTypeHelp, type TunnelTypeKind } from "@/utils/tunnelTypeHelp";
import { bestSshViaForAgent, deriveCompanion, findCompanion } from "@/utils/tunnelChain";
import { hostChoice, sameHost, type HostChoice } from "@/utils/hostChoice";
import { decodeRunLocation, encodeRunLocation, runLocationOptions } from "@/utils/runLocation";
import { TunnelDiagram } from "./TunnelDiagram";
import { TunnelChainPreviewDialog } from "./TunnelChainPreviewDialog";
import {
  bindField,
  bindOf,
  missingText,
  newTunnelType,
  openWarning,
  reachSentence,
  targetName,
  whoLabels,
} from "./tunnelForm";
import { validateTunnelType, type TunnelFieldErrors } from "./tunnelValidation";
import { newId } from "@/services/transport/ids";
import { ambiguousConnectionIds } from "@/utils/jumpHost";
import { t, tf } from "@/i18n/catalog";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { errorMessage } from "@/utils/errorMessage";
import { draftKey } from "@/utils/draftKey";
import "./TunnelEditor.css";

interface TunnelEditorProps {
  tabId: string;
  meta: TunnelEditorMeta;
  isVisible: boolean;
}

/** The traffic of a tunnel that a preview is about. */
const NO_TRAFFIC = { bytesSent: 0, bytesReceived: 0, activeConnections: 0, totalConnections: 0 };

/** Editing shape of a {@link TunnelConfig} (the fields the form owns). */
interface TunnelFormState {
  name: string;
  /** Short one-line description (#5770); `""` = none. */
  description: string;
  sshConnectionId: string;
  tunnelType: TunnelType;
  /** Where it runs; an unreadable host is left out of the save (#6028). */
  host: HostChoice;
  autoStart: boolean;
  startWithConnection: boolean;
  reconnectOnDisconnect: boolean;
}

/**
 * Client-side validation schema (UX gate only; the same checks the editor
 * previously ran by hand, translated 1:1 into zod):
 *
 * - `name` must be non-empty once trimmed (UX-022). Save is disabled outright
 *   here, so the message renders inline as the reason (UISF2-003).
 * - `sshConnectionId` must resolve to a saved SSH connection; its message shows
 *   on the SSH Connection field when no more specific error applies.
 * - the forwarding host/port fields are validated by the shared
 *   {@link validateTunnelType} (non-empty hosts, ports in 1–65535, blank
 *   rejected) — its per-field messages are re-emitted as zod issues under
 *   `tunnelType.config.*` so the inline `Field` errors stay byte-identical and
 *   the discriminated `local`/`remote`/`dynamic` union only validates the
 *   fields present on the active type.
 *
 * `tunnelType` and `host` are tagged unions carried opaquely; their real
 * validation lives in the `superRefine` above.
 */
const tunnelFormSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    sshConnectionId: z.string(),
    tunnelType: z.custom<TunnelType>(),
    host: z.custom<HostChoice>(),
    autoStart: z.boolean(),
    startWithConnection: z.boolean(),
    reconnectOnDisconnect: z.boolean(),
  })
  .superRefine((form, ctx) => {
    if (form.name.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name is required." });
    }
    if (!form.sshConnectionId) {
      ctx.addIssue({
        code: "custom",
        path: ["sshConnectionId"],
        message: "An SSH connection is required.",
      });
    }
    const { errors } = validateTunnelType(form.tunnelType);
    for (const [field, message] of Object.entries(errors)) {
      if (message) {
        ctx.addIssue({ code: "custom", path: ["tunnelType", "config", field], message });
      }
    }
  });

/**
 * The three tunnel kinds, offered as one shared radio-card selector
 * (UISF2-002). Each card says in plain words what the type does and explains
 * it on hover and keyboard focus, for the machine the tunnel runs on (#6027).
 */
function tunnelTypeOptions(host: HostChoice, agentName?: string): RadioGroupOption[] {
  const card = (kind: TunnelTypeKind): RadioGroupOption => {
    const help = tunnelTypeHelp(kind, host, agentName);
    return {
      value: kind,
      // As the New menu names it (#6076).
      label: t(`service.new.${kind}`),
      // Nothing is "here" on another machine.
      description: `${
        host.kind === "thisComputer" ? t(`service.new.${kind}.example`) : `${help.summary}.`
      } ${t(`service.new.${kind}.technical`)}`,
      help: help.lines,
    };
  };
  return [
    { ...card("local"), "data-testid": "tunnel-type-local" },
    { ...card("remote"), "data-testid": "tunnel-type-remote" },
    { ...card("dynamic"), "data-testid": "tunnel-type-dynamic" },
  ];
}

/**
 * Tab-based editor for an SSH tunnel: name, SSH connection, run-location host,
 * tunnel type (local `-L` / remote `-R` / dynamic `-D`), the type-specific
 * host/port forwarding fields, and the auto-start / reconnect toggles, plus a
 * live endpoint diagram, reachability warning, and the "chain a hop" affordance.
 *
 * Backed by react-hook-form + zod (see {@link tunnelFormSchema}). Validity and
 * the per-field errors are derived synchronously from the schema so Save
 * re-gates on the same render as an edit (and stays testable without awaiting
 * react-hook-form's async error proxy). The scalar fields are Controller-wired;
 * the discriminated `tunnelType` union and the `host` run-location are driven
 * imperatively through `setValue` because they change shape/several fields at
 * once (type switch, "Let others reach it", chaining), matching the previous hand-rolled
 * behavior exactly.
 */
export function TunnelEditor({ tabId, meta, isVisible }: TunnelEditorProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const { connections } = useProjectedConnections();
  const { remoteAgents } = useProjectedAgents();
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const reconnectTunnel = useAppStore((s) => s.reconnectTunnel);
  const openConnectionEditorTab = useAppStore((s) => s.openConnectionEditorTab);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);

  // Find existing tunnel if editing
  const existingTunnel = meta.tunnelId ? tunnels.find((t) => t.id === meta.tunnelId) : undefined;

  // SSH connections only, one entry per id. An id held by more than one
  // connection file is ambiguous: the backend refuses to host a tunnel on it
  // (#3619, the same rule as jump-host references), so it is listed but not
  // pickable, and never chosen as a default.
  const ambiguousIds = ambiguousConnectionIds(connections);
  const sshConnections = connections.filter(
    (c, i) => c.config.type === "ssh" && connections.findIndex((o) => o.id === c.id) === i
  );
  const pickableSshConnections = sshConnections.filter((c) => !ambiguousIds.has(c.id));

  // The shared RHF + zod scaffold (UISF2-003): `form` is a complete, stable
  // snapshot of the values (it reflects `setValue` at once), and `formErrors` /
  // `canSave` update on the same render as the edit.
  const {
    form: { getValues, setValue, reset },
    draft: form,
    errors: allFormErrors,
    canSave,
  } = useZodEditorForm<TunnelFormState>({
    schema: tunnelFormSchema,
    defaultValues: {
      name: existingTunnel?.name ?? "",
      description: existingTunnel?.description ?? "",
      // A new tunnel opened from a connection's "Port Forwarding" section
      // (PROD-023) pre-selects that connection when it is a saved SSH one.
      sshConnectionId:
        existingTunnel?.sshConnectionId ??
        (meta.sshConnectionId && pickableSshConnections.some((c) => c.id === meta.sshConnectionId)
          ? meta.sshConnectionId
          : undefined) ??
        pickableSshConnections[0]?.id ??
        "",
      tunnelType: existingTunnel?.tunnelType ?? newTunnelType(meta.tunnelType ?? "local"),
      // Which machine hosts this tunnel (S3, #2155). New tunnels default to This
      // computer — agent hosting is opt-in.
      host: hostChoice(existingTunnel?.host),
      autoStart: existingTunnel?.autoStart ?? false,
      // Opened from a connection's section: binding it to that connection's
      // sessions is the point, so default the flag on (PROD-023).
      startWithConnection:
        existingTunnel?.startWithConnection ?? (!existingTunnel && !!meta.sshConnectionId),
      reconnectOnDisconnect: existingTunnel?.reconnectOnDisconnect ?? false,
    },
  });

  // Errors show once the user edited a field and left it, or tried to save
  // (#5909) — a new tunnel does not open with "Name is required." in red.
  // `canSave` still reads every error.
  const { shown: formErrors, rootProps, revealAndFocus } = useRevealOnSave(allFormErrors, form);

  // Sync if the tunnel ID changes (reload the working copy from the store).
  // Keyed on the id, not the object: a republish of the tunnels list (a status
  // change, or the backend following a connection rename) must not clobber the
  // unsaved edits — the draft follows renames itself below (#3603).
  const existingTunnelId = existingTunnel?.id;
  // The values the editor was opened (or last reloaded) with: the draft differing
  // from them is what marks the tab dirty (UX2-004).
  const [baselineKey, setBaselineKey] = useState(() => draftKey(getValues()));
  // Unsaved values carried in from another window by "Move tabs" (#4500). They
  // replace the working copy once it is loaded, while the baseline stays the
  // saved tunnel (or a new tunnel's defaults), so the moved editor is dirty.
  const carriedDraft = useCarriedFormDraft<TunnelFormState>(tabId, "tunnel-editor");
  useEffect(() => {
    if (!existingTunnel && carriedDraft && !meta.tunnelId) reset(carriedDraft);
    // Applied once, on mount; a saved tunnel's draft is applied when it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (existingTunnel) {
      const loaded: TunnelFormState = {
        name: existingTunnel.name,
        description: existingTunnel.description ?? "",
        sshConnectionId: existingTunnel.sshConnectionId,
        tunnelType: existingTunnel.tunnelType,
        host: hostChoice(existingTunnel.host),
        autoStart: existingTunnel.autoStart,
        startWithConnection: existingTunnel.startWithConnection ?? false,
        reconnectOnDisconnect: existingTunnel.reconnectOnDisconnect,
      };
      reset(carriedDraft ?? loaded);
      setBaselineKey(draftKey(loaded));
    }
    // Keyed on the id (see above): a republished tunnel object must not reset
    // the unsaved draft, and the carried draft is only read when the tunnel loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingTunnelId]);

  // Pull the tagged unions into locals so the `isAgentHost` type guard narrows
  // through into the closures below (control-flow narrowing of a property access
  // does not persist into nested callbacks; a `const` local's does).
  const { tunnelType, host } = form;

  // Report unsaved edits like ConnectionEditor does, so the tab-bar close guard
  // and every bulk close (panel, group, window) see this tab as dirty (UX2-004).
  const isDirty = draftKey(form) !== baselineKey;
  const tab = useEditorTab(tabId, isDirty);

  // Hand the unsaved draft to "Move tabs" on window close (#4500). A tunnel
  // form holds no secrets today; the check still runs, so a future one is
  // cleared rather than carried.
  useFormDraftProvider(tabId, () => {
    if (!isDirty) return null;
    const { values, cleared } = clearDraftSecrets(getValues());
    return {
      kind: "tunnel-editor",
      values: values as unknown as Record<string, unknown>,
      ...(cleared.length > 0 ? { clearedSecrets: cleared } : {}),
    };
  });

  const handleTypeChange = (type: "local" | "remote" | "dynamic") => {
    if (getValues("tunnelType").type !== type) {
      setValue("tunnelType", newTunnelType(type));
    }
  };

  // Update a single forwarding host/port field by rebuilding the whole tagged
  // `tunnelType` object — the discriminated union is carried as one form value
  // (rather than per-leaf paths) so a type switch never leaks stale leaves.
  const updateConfig = (field: string, value: string | number | "") => {
    const prev = getValues("tunnelType");
    let next: TunnelType;
    switch (prev.type) {
      case "local":
        next = { type: "local", config: { ...prev.config, [field]: value } };
        break;
      case "remote":
        next = { type: "remote", config: { ...prev.config, [field]: value } };
        break;
      case "dynamic":
        next = { type: "dynamic", config: { ...prev.config, [field]: value } };
        break;
    }
    setValue("tunnelType", next);
  };

  // The forwarding host/port errors, keyed by config field name for the inline
  // `Field` errors below.
  const errors = useMemo<TunnelFieldErrors>(() => {
    const prefix = "tunnelType.config.";
    const fieldErrors: TunnelFieldErrors = {};
    for (const [path, message] of Object.entries(formErrors)) {
      if (path.startsWith(prefix)) fieldErrors[path.slice(prefix.length)] = message;
    }
    return fieldErrors;
  }, [formErrors]);

  // Build the parent `TunnelConfig` from the current editor state. Shared by
  // Save and by "Chain a hop" (which must persist the parent before linking a
  // companion to its id). The id is stable across both so chaining a freshly
  // built tunnel links to the same row Save creates.
  const buildConfig = (values: TunnelFormState): TunnelConfig => ({
    id: existingTunnel?.id ?? newId("tun"),
    // Save refuses to save while the name is blank (UX-022, #5284), so this
    // fallback only ever guards the non-Save caller (chaining a hop).
    name: values.name.trim() || "Untitled Tunnel",
    description: normalizeItemDescription(values.description),
    sshConnectionId: values.sshConnectionId,
    tunnelType: values.tunnelType,
    // Left out, the backend keeps the stored host it cannot read either.
    host: values.host.kind === "unreadable" ? undefined : values.host,
    autoStart: values.autoStart,
    startWithConnection: values.startWithConnection,
    reconnectOnDisconnect: values.reconnectOnDisconnect,
    companionOf: existingTunnel?.companionOf,
  });

  const handleSave = async (andStart: boolean) => {
    // Save stays keyboard-reachable while invalid (aria-disabled, not
    // disabled): activating it then points at the problem instead of saving.
    if (!canSave) {
      revealAndFocus();
      return;
    }
    const config = buildConfig(getValues());

    try {
      await saveTunnel(config);
      if (andStart) {
        (active ? reconnectTunnel : startTunnel)(config.id).catch((err) => {
          frontendLog("tunnel_editor", `Failed to start tunnel after save: ${errorMessage(err)}`);
          toast.error("Failed to start tunnel");
        });
      }
      // A plain save closes the editor and the tunnel's row shows in the
      // sidebar; that is the confirmation (#5859, superseding UX-022).
      tab.close();
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to save tunnel: ${errorMessage(err)}`);
      throw err instanceof Error ? err : new Error("Failed to save tunnel");
    }
  };

  const sshOptions = sshConnections.map((c) =>
    ambiguousIds.has(c.id)
      ? { value: c.id, label: `${c.name} (in several connection files)`, disabled: true }
      : { value: c.id, label: c.name }
  );
  const sshConnectionAmbiguous = ambiguousIds.has(form.sshConnectionId);
  // The backend reports this tunnel's SSH connection as deleted (#2850) and the
  // draft still names no existing one: flag it so the user repoints the tunnel.
  const sshConnectionMissing =
    existingTunnel !== undefined &&
    tunnelStates[existingTunnel.id]?.status === "missingConnection" &&
    !sshConnections.some((c) => c.id === form.sshConnectionId);

  // Tunnel host (run-location) selector: This computer + every remote agent.
  const hostOptions = runLocationOptions(remoteAgents, true, host);
  // Saving another machine for a running tunnel stops it (#6028).
  const savedStatus = existingTunnel && tunnelStates[existingTunnel.id]?.status;
  const active = isServiceActive(tunnelServiceState(savedStatus));
  const movesRunning =
    existingTunnel !== undefined && active && !sameHost(host, hostChoice(existingTunnel.host));
  const hostAgentName = isAgentHost(host)
    ? (remoteAgents.find((a) => a.id === host.agentId)?.name ?? host.agentId)
    : undefined;
  const sshLabel = sshConnections.find((c) => c.id === form.sshConnectionId)?.name;
  const endpointLines = tunnelEndpointLines(tunnelType, host, {
    agentName: hostAgentName,
    sshLabel,
  });
  const reachability = tunnelReachabilityWarning(tunnelType, host, hostAgentName);

  /** Widen an agent-hosted loopback bind to 0.0.0.0 so this computer can reach it. */
  const handleWidenBind = () => {
    updateConfig("localHost", WIDE_BIND_HOST);
  };

  // ── Chain a hop to this computer (#2597) ──────────────────────────────────
  // The affordance sits beside "Let others reach it" on the same reachability warning.
  // It is offered only for a *saved* agent-hosted loopback parent (chaining links
  // a companion to the parent's persisted id), disabled while the host agent is
  // offline, and replaced by "Chained ✓ · reveal" once a companion exists.
  const hostAgent = isAgentHost(host) ? remoteAgents.find((a) => a.id === host.agentId) : undefined;
  const agentOnline = hostAgent?.connectionState === "connected";
  const existingCompanion = existingTunnel ? findCompanion(tunnels, existingTunnel.id) : undefined;

  // The user's saved SSH connections as SSH-via candidates for the companion —
  // its `sshConnectionId` must resolve to a saved SSH connection (the backend has
  // no agent→connection link), so we match one whose host reaches the agent.
  const sshViaCandidates = pickableSshConnections.map((c) => ({
    id: c.id,
    host: typeof c.config.config.host === "string" ? c.config.config.host : "",
  }));
  const [chainOpen, setChainOpen] = useState(false);
  const [chainSshId, setChainSshId] = useState("");
  const [chainStartNow, setChainStartNow] = useState(true);

  // A connection renamed while the editor is open: re-point the draft's SSH
  // connection (and a pending chain hop's), or saving would write the old id
  // back over the backend's follow (#3603). An untouched draft stays clean.
  useConnectionIdChanges((remap) => {
    const current = getValues("sshConnectionId");
    if (current) {
      const mapped = remap(current);
      if (mapped !== current) {
        const before = draftKey(getValues());
        setValue("sshConnectionId", mapped, { shouldValidate: true });
        const after = draftKey(getValues());
        setBaselineKey((prev) => (prev === before ? after : prev));
      }
    }
    setChainSshId((prev) => (prev ? remap(prev) : prev));
  });

  const handleOpenChain = () => {
    setChainSshId(bestSshViaForAgent(sshViaCandidates, hostAgent?.config.host) ?? "");
    setChainStartNow(true);
    setChainOpen(true);
  };

  const handleRevealCompanion = () => {
    if (existingCompanion) openTunnelEditorTab(existingCompanion.id);
  };

  const handleChainConfirm = async () => {
    const parent = buildConfig(getValues());
    const companion = deriveCompanion(parent, chainSshId);
    try {
      // Persist the parent first so the companion can link to its id, then the
      // companion. Starting the parent brings the companion up in dependency
      // order (the backend's ordered pair lifecycle, #2597).
      await saveTunnel(parent);
      await saveTunnel(companion);
      if (chainStartNow) {
        startTunnel(parent.id).catch((err) => {
          frontendLog("tunnel_editor", `Failed to start chained pair: ${errorMessage(err)}`);
          toast.error("Failed to start chained pair");
        });
      }
      setChainOpen(false);
      tab.close();
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to chain hop: ${errorMessage(err)}`);
      toast.error("Failed to chain a hop to this computer");
    }
  };

  // The companion the preview describes, derived from the current parent draft.
  const chainCompanion = deriveCompanion(buildConfig(form), chainSshId);
  const chainCompanionLocal =
    chainCompanion.tunnelType.type === "local" ? chainCompanion.tunnelType.config : undefined;

  // What one came for has the focus: over a preset of a new tunnel one types at once,
  // a saved value is not lost by it (U-008).
  const { ref: fieldsRef } = rootProps;
  const selects = useRef(!existingTunnel);
  useEffect(() => {
    const first = fieldsRef.current?.querySelector<HTMLInputElement>(
      ".service-editor__first input"
    );
    first?.focus();
    if (selects.current) first?.select();
  }, [fieldsRef]);

  // Which footer action is primary (#5810): a new tunnel is saved to be used,
  // so "Save and start" is primary; editing an existing one keeps "Save".
  const saveAndStartIsPrimary = !existingTunnel;
  // The primary footer Button. Enter clicks it, so the keyboard runs the same
  // action — with the same pending state, error handling and invalid-form
  // guard — as the button the user sees highlighted.
  const primaryButtonRef = useRef<HTMLButtonElement>(null);

  // Enter (from a single-line field) runs the primary action; Escape cancels.
  // While invalid, Enter goes through the same guard as the button and focuses
  // the first invalid field instead of saving.
  const handleKeyDown = useEditorKeyboard({
    onSubmit: () => primaryButtonRef.current?.click(),
    onCancel: tab.cancel,
  });

  const saveAndStartButton = (
    <Button
      ref={saveAndStartIsPrimary ? primaryButtonRef : undefined}
      variant={saveAndStartIsPrimary ? "primary" : "secondary"}
      onClick={() => handleSave(true)}
      aria-disabled={!canSave}
      data-invalid={!canSave || undefined}
      data-testid="tunnel-editor-save-start"
    >
      {t(active ? "service.editor.saveAndRestart" : "service.editor.saveAndStart")}
    </Button>
  );
  const saveButton = (
    <Button
      ref={saveAndStartIsPrimary ? undefined : primaryButtonRef}
      variant={saveAndStartIsPrimary ? "secondary" : "primary"}
      onClick={() => handleSave(false)}
      aria-disabled={!canSave}
      data-invalid={!canSave || undefined}
      data-testid="tunnel-editor-save"
    >
      {t("service.editor.save")}
    </Button>
  );

  const machines = { host, agentName: hostAgentName, server: sshLabel };
  const here = host.kind === "thisComputer";
  const bind = bindField(tunnelType);
  const warning = openWarning(tunnelType, machines);
  const context = useServiceContext(isWideBind(bindOf(tunnelType)));
  const preview = tunnelModel(
    { ...buildConfig(form), id: "" },
    { tunnelId: "", status: "connected", stats: NO_TRAFFIC },
    context
  ).address;
  // Asked only when the New menu did not (U-008).
  const [choosing, setChoosing] = useState(!existingTunnel && !meta.tunnelType);
  const [showsPath, setShowsPath] = useState(false);

  /** A tunnel without a name is called like what it reaches, once that is known. */
  const nameAfterTarget = () => {
    const name = targetName(getValues("tunnelType"));
    if (name && getValues("name").trim() === "") setValue("name", name);
  };
  const portInput = (
    field: "localPort" | "remotePort",
    label: string,
    value: number | "",
    className = "service-editor__port"
  ) => (
    <Field
      label={label}
      htmlFor={`tunnel-${field}-${tabId}`}
      className={className}
      error={errors[field]}
    >
      <NumberInput
        id={`tunnel-${field}-${tabId}`}
        value={value}
        onValueChange={(v) => updateConfig(field, v)}
        error={!!errors[field]}
        data-testid={
          field === "localPort" ? "tunnel-editor-local-port" : "tunnel-editor-remote-port"
        }
      />
    </Field>
  );
  const hostInput = (field: "localHost" | "remoteHost", label: string, value: string) => (
    <Field label={label} htmlFor={`tunnel-${field}-${tabId}`} error={errors[field]}>
      <Input
        id={`tunnel-${field}-${tabId}`}
        type="text"
        value={value}
        onChange={(e) => updateConfig(field, e.target.value)}
        onBlur={nameAfterTarget}
        error={!!errors[field]}
        data-testid={
          field === "localHost" ? "tunnel-editor-local-host" : "tunnel-editor-remote-host"
        }
      />
    </Field>
  );
  // What it reaches: at the far end, or here for a server.
  const target = (() => {
    switch (tunnelType.type) {
      case "local":
        return (
          <div className="service-editor__row service-editor__first">
            {hostInput("remoteHost", t("tunnel.editor.target.local"), tunnelType.config.remoteHost)}
            {portInput("remotePort", t("tunnel.editor.target.port"), tunnelType.config.remotePort)}
          </div>
        );
      case "remote":
        return (
          <div className="service-editor__row service-editor__first">
            {hostInput(
              "localHost",
              t(here ? "tunnel.editor.target.remote" : "tunnel.editor.target.remote.there"),
              tunnelType.config.localHost
            )}
            {portInput("localPort", t("tunnel.editor.target.port"), tunnelType.config.localPort)}
          </div>
        );
      case "dynamic":
        return null;
    }
  })();
  const openedPort =
    tunnelType.type === "remote"
      ? portInput(
          "remotePort",
          t("tunnel.editor.port.server"),
          tunnelType.config.remotePort,
          "service-editor__opened"
        )
      : portInput(
          "localPort",
          t(here ? "tunnel.editor.port.here" : "tunnel.editor.port.there"),
          tunnelType.config.localPort,
          "service-editor__opened"
        );

  const check = (
    name: "autoStart" | "startWithConnection" | "reconnectOnDisconnect",
    label: string,
    testId: string
  ) => (
    <label className="service-editor__check">
      <Checkbox
        checked={form[name]}
        onCheckedChange={(checked) => setValue(name, checked === true)}
        aria-label={label}
        data-testid={testId}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <ServiceEditorShell
      testId="tunnel-editor"
      isVisible={isVisible}
      title={existingTunnel ? existingTunnel.name : t(`service.new.${tunnelType.type}`)}
      subtitle={editorSubtitle(!existingTunnel, t(`service.new.${tunnelType.type}.technical`))}
      onChangeType={choosing ? undefined : () => setChoosing(true)}
      rootProps={rootProps}
      onKeyDown={handleKeyDown}
      note={
        canSave
          ? active && isDirty && !movesRunning
            ? t("service.editor.afterRestart")
            : undefined
          : missingText(tunnelType, allFormErrors)
      }
      actions={
        <>
          <Button variant="secondary" onClick={tab.cancel} data-testid="tunnel-editor-cancel">
            {t("service.action.cancel")}
          </Button>
          {/* One primary per footer, on the right (copy style guide). */}
          {!saveAndStartIsPrimary && saveAndStartButton}
          {saveButton}
          {saveAndStartIsPrimary && saveAndStartButton}
        </>
      }
    >
      {choosing && (
        <div className="service-editor__group">
          <span className="service-editor__label" id={`tunnel-type-label-${tabId}`}>
            {t("tunnel.editor.type")}
          </span>
          <RadioGroup
            variant="cards"
            orientation="horizontal"
            value={tunnelType.type}
            onValueChange={(v) => handleTypeChange(v as "local" | "remote" | "dynamic")}
            aria-labelledby={`tunnel-type-label-${tabId}`}
            data-testid="tunnel-editor-type-selector"
            options={tunnelTypeOptions(host, hostAgentName)}
          />
        </div>
      )}

      {target}

      <div className="service-editor__row service-editor__row--even">
        <Field
          label={t("tunnel.editor.server")}
          htmlFor={`tunnel-ssh-${tabId}`}
          error={
            sshConnectionAmbiguous
              ? "A connection with this id exists in more than one connection file, so the " +
                "tunnel cannot be hosted on it. Rename or move one of them, or pick another " +
                "SSH connection."
              : sshConnectionMissing
                ? t("tunnel.editor.missingConnection")
                : formErrors.sshConnectionId
          }
          details={
            sshConnections.length === 0 && (
              <button
                type="button"
                className="service-editor__link"
                onClick={() => openConnectionEditorTab("new")}
                data-testid="tunnel-editor-new-connection"
              >
                {t("service.empty.newConnection")}
              </button>
            )
          }
          data-testid="tunnel-editor-ssh-connection-field"
        >
          <Select
            id={`tunnel-ssh-${tabId}`}
            value={sshConnectionMissing ? undefined : form.sshConnectionId || undefined}
            onChange={(v) => setValue("sshConnectionId", v)}
            options={sshOptions}
            placeholder={
              sshConnectionMissing && sshOptions.length > 0
                ? t("tunnel.editor.chooseSshConnection")
                : t("tunnel.editor.noServer")
            }
            aria-label={t("tunnel.editor.server")}
            data-testid="tunnel-editor-ssh-connection"
          />
        </Field>
        <Field
          label={t("tunnel.editor.runOn")}
          htmlFor={`tunnel-host-${tabId}`}
          hint={movesRunning ? t("service.host.moveHint") : undefined}
          data-testid="tunnel-editor-host-field"
        >
          <Select
            id={`tunnel-host-${tabId}`}
            value={encodeRunLocation(host)}
            onChange={(v) => setValue("host", decodeRunLocation(v))}
            options={hostOptions}
            aria-label={t("tunnel.editor.runOn")}
            data-testid="tunnel-editor-host"
          />
        </Field>
      </div>

      <div className={tunnelType.type === "dynamic" ? "service-editor__first" : undefined}>
        {openedPort}
      </div>

      <WhoCanOpen
        testId="tunnel-editor"
        id={`tunnel-${tabId}`}
        key={tunnelType.type}
        bind={bindOf(tunnelType)}
        onBind={(address) => updateConfig(bind, address)}
        labels={whoLabels(tunnelType, machines)}
        here={tunnelType.type === "remote" ? "localhost" : "127.0.0.1"}
        onThisComputer={here && tunnelType.type !== "remote"}
        error={errors[bind]}
      />
      {warning && (
        <ServiceEditorWarning testId="tunnel-editor-warning">{warning}</ServiceEditorWarning>
      )}
      {preview && (
        <p className="service-editor__sentence" data-testid="tunnel-editor-sentence">
          {preview.copy ? (
            <>
              {t("server.editor.address")} <code>{preview.copy}</code> · {preview.reach}
            </>
          ) : (
            preview.reach
          )}
          <br />
          {reachSentence(tunnelType, machines)}
        </p>
      )}

      {reachability && (
        <ServiceEditorWarning testId="tunnel-editor-reachability">
          {reachability.message}{" "}
          <button
            type="button"
            className="service-editor__warning-link"
            onClick={handleWidenBind}
            data-testid="tunnel-editor-widen-bind"
          >
            {t("tunnel.editor.letOthers")}
          </button>
          {" · "}
          {existingCompanion ? (
            <button
              type="button"
              className="service-editor__warning-link"
              onClick={handleRevealCompanion}
              data-testid="tunnel-editor-chain-reveal"
            >
              {t("tunnel.editor.broughtHere")}
            </button>
          ) : (
            <button
              type="button"
              className="service-editor__warning-link"
              onClick={handleOpenChain}
              disabled={!agentOnline}
              title={
                agentOnline
                  ? undefined
                  : tf("tunnel.editor.bringHere.offline", { agent: hostAgent?.name ?? "host" })
              }
              data-testid="tunnel-editor-chain-hop"
            >
              {t("tunnel.editor.bringHere")}
            </button>
          )}
        </ServiceEditorWarning>
      )}

      <Field
        label={t("server.editor.name")}
        htmlFor={`tunnel-name-${tabId}`}
        error={formErrors.name}
      >
        <Input
          id={`tunnel-name-${tabId}`}
          type="text"
          value={form.name}
          error={!!formErrors.name}
          onChange={(e) => setValue("name", e.target.value)}
          placeholder={t("tunnel.editor.name.placeholder")}
          data-testid="tunnel-editor-name"
        />
      </Field>
      <Field label={t("server.editor.description")} htmlFor={`tunnel-description-${tabId}`}>
        <Input
          id={`tunnel-description-${tabId}`}
          type="text"
          value={form.description}
          onChange={(e) => setValue("description", e.target.value)}
          maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
          placeholder={t("tunnel.editor.description.placeholder")}
          data-testid="tunnel-editor-description"
        />
      </Field>

      <div className="service-editor__group">
        <span className="service-editor__label">{t("tunnel.editor.start")}</span>
        {check("autoStart", t("tunnel.editor.autoStart"), "tunnel-editor-auto-start")}
        {check(
          "startWithConnection",
          tf("tunnel.editor.startWithConnection", {
            server: sshLabel ?? t("service.what.unknownServer"),
          }),
          "tunnel-editor-start-with-connection"
        )}
        {check("reconnectOnDisconnect", t("tunnel.editor.reconnect"), "tunnel-editor-reconnect")}
      </div>

      <div className="service-editor__group">
        <button
          type="button"
          className="service-editor__link service-editor__link--row"
          aria-expanded={showsPath}
          onClick={() => setShowsPath(!showsPath)}
          data-testid="tunnel-editor-show-path"
        >
          {t(showsPath ? "tunnel.editor.hidePath" : "tunnel.editor.showPath")}
        </button>
        {showsPath && (
          <>
            <TunnelDiagram tunnelType={tunnelType} agentName={hostAgentName} />
            <div className="tunnel-editor__endpoints" data-testid="tunnel-editor-endpoints">
              <div className="tunnel-editor__endpoints-host">
                {isAgentHost(host) ? <Server size={13} /> : <Monitor size={13} />}
                <span>
                  {t("tunnel.editor.runsOn")}{" "}
                  <strong>{tunnelHostMachine(host, hostAgentName)}</strong>
                </span>
              </div>
              {endpointLines.map((line, i) => (
                <div className="tunnel-editor__endpoint-line" key={i}>
                  <strong>{line.label}</strong> {line.machine && <span>{line.machine}</span>}
                  {line.machine && line.address ? " · " : ""}
                  {line.address && <code>{line.address}</code>}
                  {line.note && (
                    <span className="tunnel-editor__endpoint-note"> ({line.note})</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <TunnelChainPreviewDialog
        open={chainOpen}
        onOpenChange={setChainOpen}
        port={reachability ? (tunnelType.type !== "remote" ? tunnelType.config.localPort : "") : ""}
        agentName={hostAgentName ?? "the agent"}
        companionListen={
          chainCompanionLocal
            ? `${chainCompanionLocal.localHost}:${chainCompanionLocal.localPort === "" ? "?" : chainCompanionLocal.localPort}`
            : ""
        }
        companionForwards={
          chainCompanionLocal
            ? `${chainCompanionLocal.remoteHost}:${chainCompanionLocal.remotePort === "" ? "?" : chainCompanionLocal.remotePort}`
            : ""
        }
        sshOptions={sshOptions}
        sshConnectionId={chainSshId}
        onSshConnectionChange={setChainSshId}
        startNow={chainStartNow}
        onStartNowChange={setChainStartNow}
        onConfirm={handleChainConfirm}
      />

      <UnsavedChangesDialog
        open={tab.asking}
        subject="tunnel"
        name={form.name.trim() || undefined}
        onCancel={tab.stopAsking}
        onJustClose={() => {
          tab.stopAsking();
          tab.close();
        }}
        onSaveAndClose={
          canSave
            ? async () => {
                // Save closes the tab on success; on failure it throws, the
                // Button toasts the error and the prompt stays up.
                await handleSave(false);
                tab.stopAsking();
              }
            : undefined
        }
      />
    </ServiceEditorShell>
  );
}
