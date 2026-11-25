import { useState, useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "@/utils/itemDescription";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { useZodEditorForm } from "@/hooks/useZodEditorForm";
import { useRevealedErrors } from "@/hooks/useRevealedErrors";
import { useCarriedFormDraft, useFormDraftProvider } from "@/hooks/useFormDraftHandoff";
import { clearDraftSecrets } from "@/utils/formDraftSecrets";
import { Monitor, Server, AlertTriangle, Link2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useLayoutRenderTree } from "@/store/layoutSelectors";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import {
  TunnelConfig,
  TunnelType,
  LocalForwardConfig,
  RemoteForwardConfig,
  DynamicForwardConfig,
} from "@/types/tunnel";
import { TunnelEditorMeta } from "@/types/terminal";
import {
  Button,
  Input,
  NumberInput,
  RadioGroup,
  type RadioGroupOption,
  Select,
  Field,
  Toggle,
  UnsavedChangesDialog,
  toast,
  TOAST_AVOID_PROPS,
  TOAST_AVOID_FORM_PROPS,
} from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { frontendLog } from "@/utils/frontendLog";
import {
  isAgentHost,
  tunnelHostMachine,
  tunnelEndpointLines,
  tunnelReachabilityWarning,
  WIDE_BIND_HOST,
} from "@/utils/tunnelHost";
import { tunnelTypeHelp, type TunnelTypeKind } from "@/utils/tunnelTypeHelp";
import { bestSshViaForAgent, deriveCompanion, findCompanion } from "@/utils/tunnelChain";
import { hostChoice, sameHost, type HostChoice } from "@/utils/hostChoice";
import { decodeRunLocation, encodeRunLocation, runLocationOptions } from "@/utils/runLocation";
import { TunnelDiagram } from "./TunnelDiagram";
import { TunnelChainPreviewDialog } from "./TunnelChainPreviewDialog";
import { validateTunnelType, type TunnelFieldErrors } from "./tunnelValidation";
import { newId } from "@/services/transport/ids";
import { ambiguousConnectionIds } from "@/utils/jumpHost";
import { t } from "@/i18n/catalog";
import { useConnectionIdChanges } from "@/hooks/useFollowConnectionIdChanges";
import { errorMessage } from "@/utils/errorMessage";
import { draftKey } from "@/utils/draftKey";
import { findLeafByTab } from "@/utils/panelTree";
import "./TunnelEditor.css";

interface TunnelEditorProps {
  tabId: string;
  meta: TunnelEditorMeta;
  isVisible: boolean;
}

const DEFAULT_LOCAL: LocalForwardConfig = {
  localHost: "127.0.0.1",
  localPort: 8080,
  remoteHost: "localhost",
  remotePort: 80,
};

const DEFAULT_REMOTE: RemoteForwardConfig = {
  remoteHost: "0.0.0.0",
  remotePort: 8080,
  localHost: "127.0.0.1",
  localPort: 3000,
};

const DEFAULT_DYNAMIC: DynamicForwardConfig = {
  localHost: "127.0.0.1",
  localPort: 1080,
};

function defaultTunnelType(type: "local" | "remote" | "dynamic"): TunnelType {
  switch (type) {
    case "local":
      return { type: "local", config: { ...DEFAULT_LOCAL } };
    case "remote":
      return { type: "remote", config: { ...DEFAULT_REMOTE } };
    case "dynamic":
      return { type: "dynamic", config: { ...DEFAULT_DYNAMIC } };
  }
}

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
      label: help.label,
      description: (
        <>
          <span className="tunnel-editor__type-summary">{help.summary}</span>{" "}
          <code className="tunnel-editor__type-flag">{help.flag}</code>
        </>
      ),
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
 * once (type switch, "Widen bind", chaining), matching the previous hand-rolled
 * behavior exactly.
 */
export function TunnelEditor({ tabId, meta, isVisible }: TunnelEditorProps) {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const { connections } = useProjectedConnections();
  const { remoteAgents } = useProjectedAgents();
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const closeTab = useAppStore((s) => s.closeTab);
  const setEditorDirty = useAppStore((s) => s.setEditorDirty);
  const pendingCloseRequest = useAppStore((s) => s.pendingCloseRequest);
  const setPendingCloseRequest = useAppStore((s) => s.setPendingCloseRequest);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const rootPanel = useLayoutRenderTree();

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
    form: { control, getValues, setValue, reset },
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
      tunnelType: existingTunnel?.tunnelType ?? defaultTunnelType("local"),
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
  const {
    shown: formErrors,
    revealProps,
    revealAll: revealAllErrors,
  } = useRevealedErrors(allFormErrors, form);

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
  useEffect(() => {
    setEditorDirty(tabId, isDirty);
  }, [tabId, isDirty, setEditorDirty]);

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
      setValue("tunnelType", defaultTunnelType(type));
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

  const formRef = useRef<HTMLDivElement>(null);

  /**
   * Move focus to the first field that blocks Save, in visual order, so a user
   * who activates the (aria-disabled) Save sees why it did not save. Every
   * invalid field carries `aria-invalid` (injected by `Field` alongside the
   * inline message), so the first one in DOM order is the first invalid field.
   */
  const focusFirstInvalidField = () => {
    const target = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (target) {
      target.scrollIntoView?.({ block: "center" });
      target.focus();
    }
  };

  const handleSave = async (andStart: boolean) => {
    // Save stays keyboard-reachable while invalid (aria-disabled, not
    // disabled): activating it then points at the problem instead of saving.
    if (!canSave) {
      // Render every error first: the focus target is the first `aria-invalid`.
      flushSync(revealAllErrors);
      focusFirstInvalidField();
      return;
    }
    const config = buildConfig(getValues());

    try {
      await saveTunnel(config);
      if (andStart) {
        startTunnel(config.id).catch((err) => {
          frontendLog("tunnel_editor", `Failed to start tunnel after save: ${errorMessage(err)}`);
          toast.error("Failed to start tunnel");
        });
      }
      // A plain save closes the editor and the tunnel's row shows in the
      // sidebar; that is the confirmation (#5859, superseding UX-022).
      // Find panelId for this tab and close it
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) {
        closeTab(tabId, leaf.id);
      }
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to save tunnel: ${errorMessage(err)}`);
      throw err instanceof Error ? err : new Error("Failed to save tunnel");
    }
  };

  const closeThisTab = () => {
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) closeTab(tabId, leaf.id);
  };

  // Cancel and Escape share the tab-bar close guard (UX2-004): with unsaved
  // edits they raise the unsaved-changes prompt via pendingCloseRequest;
  // otherwise the tab closes at once.
  const handleCancel = () => {
    if (useAppStore.getState().editorDirtyTabs[tabId]) {
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) setPendingCloseRequest({ tabId, panelId: leaf.id });
      return;
    }
    closeThisTab();
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
  const movesRunning =
    existingTunnel !== undefined &&
    (savedStatus === "connected" ||
      savedStatus === "connecting" ||
      savedStatus === "reconnecting") &&
    !sameHost(host, hostChoice(existingTunnel.host));
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
  // The affordance sits beside "Widen bind" on the same reachability warning.
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
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) closeTab(tabId, leaf.id);
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to chain hop: ${errorMessage(err)}`);
      toast.error("Failed to chain a hop to this computer");
    }
  };

  // The companion the preview describes, derived from the current parent draft.
  const chainCompanion = deriveCompanion(buildConfig(form), chainSshId);
  const chainCompanionLocal =
    chainCompanion.tunnelType.type === "local" ? chainCompanion.tunnelType.config : undefined;

  const nameRef = useAutofocusSelect<HTMLInputElement>();

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
    onCancel: handleCancel,
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
      Save and start
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
      Save
    </Button>
  );

  return (
    <div
      className={`tunnel-editor ${isVisible ? "" : "tunnel-editor--hidden"}`}
      data-testid="tunnel-editor"
      onKeyDown={handleKeyDown}
    >
      <div className="tunnel-editor__header">
        <span className="tunnel-editor__title" data-testid="tunnel-editor-title">
          {existingTunnel ? `Edit tunnel: ${existingTunnel.name}` : "New SSH tunnel"}
        </span>
      </div>

      <div
        className="tunnel-editor__form"
        ref={formRef}
        data-testid="tunnel-editor-form"
        {...revealProps}
        {...TOAST_AVOID_FORM_PROPS}
      >
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <Field label="Name" htmlFor={`tunnel-name-${tabId}`} error={formErrors.name}>
              <Input
                ref={nameRef}
                id={`tunnel-name-${tabId}`}
                type="text"
                value={field.value ?? ""}
                error={!!formErrors.name}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                placeholder="e.g. Dev Database"
                data-testid="tunnel-editor-name"
              />
            </Field>
          )}
        />

        <Controller
          name="description"
          control={control}
          render={({ field }) => (
            <Field
              label="Description (optional)"
              htmlFor={`tunnel-description-${tabId}`}
              hint="One short line shown under the name in the sidebar."
            >
              <Input
                id={`tunnel-description-${tabId}`}
                type="text"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                maxLength={ITEM_DESCRIPTION_MAX_LENGTH}
                placeholder="What this tunnel is for"
                data-testid="tunnel-editor-description"
              />
            </Field>
          )}
        />

        <Field
          label="SSH connection"
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
                : "No SSH connections available"
            }
            aria-label="SSH connection"
            data-testid="tunnel-editor-ssh-connection"
          />
        </Field>

        <Field
          label="Tunnel host"
          htmlFor={`tunnel-host-${tabId}`}
          hint={movesRunning ? t("service.host.moveHint") : undefined}
          data-testid="tunnel-editor-host-field"
        >
          <Select
            id={`tunnel-host-${tabId}`}
            value={encodeRunLocation(host)}
            onChange={(v) => setValue("host", decodeRunLocation(v))}
            options={hostOptions}
            aria-label="Tunnel host"
            data-testid="tunnel-editor-host"
          />
        </Field>

        <div className="tunnel-editor__field">
          <span className="tunnel-editor__label" id={`tunnel-type-label-${tabId}`}>
            Tunnel type
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

        <TunnelDiagram tunnelType={tunnelType} agentName={hostAgentName} />

        <div className="tunnel-editor__endpoints" data-testid="tunnel-editor-endpoints">
          <div className="tunnel-editor__endpoints-host">
            {isAgentHost(host) ? <Server size={13} /> : <Monitor size={13} />}
            <span>
              Host: <strong>{tunnelHostMachine(host, hostAgentName)}</strong>
            </span>
          </div>
          {endpointLines.map((line, i) => (
            <div className="tunnel-editor__endpoint-line" key={i}>
              <strong>{line.label}</strong> {line.machine && <span>{line.machine}</span>}
              {line.machine && line.address ? " · " : ""}
              {line.address && <code>{line.address}</code>}
              {line.note && <span className="tunnel-editor__endpoint-note"> ({line.note})</span>}
            </div>
          ))}
        </div>

        {reachability && (
          <div className="tunnel-editor__reachability" data-testid="tunnel-editor-reachability">
            <AlertTriangle size={14} className="tunnel-editor__reachability-icon" />
            <span className="tunnel-editor__reachability-text">
              {reachability.message}{" "}
              <button
                type="button"
                className="tunnel-editor__reachability-action"
                onClick={handleWidenBind}
                data-testid="tunnel-editor-widen-bind"
              >
                Widen bind
              </button>
              {" · "}
              {existingCompanion ? (
                <button
                  type="button"
                  className="tunnel-editor__reachability-action"
                  onClick={handleRevealCompanion}
                  data-testid="tunnel-editor-chain-reveal"
                >
                  <Link2 size={12} className="tunnel-editor__reachability-action-icon" /> Chained
                  &#10003; &middot; reveal
                </button>
              ) : (
                <button
                  type="button"
                  className="tunnel-editor__reachability-action"
                  onClick={handleOpenChain}
                  disabled={!agentOnline}
                  title={
                    agentOnline
                      ? undefined
                      : `Agent ${hostAgent?.name ?? "host"} is offline — connect it to chain a hop`
                  }
                  data-testid="tunnel-editor-chain-hop"
                >
                  <Link2 size={12} className="tunnel-editor__reachability-action-icon" /> Chain a
                  hop to this computer
                </button>
              )}
            </span>
          </div>
        )}

        {tunnelType.type === "local" && (
          <>
            <span className="tunnel-editor__section-title">Local bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local host"
                htmlFor={`tunnel-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local port"
                htmlFor={`tunnel-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
            <span className="tunnel-editor__section-title">Remote target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Remote host"
                htmlFor={`tunnel-remote-host-${tabId}`}
                error={errors.remoteHost}
              >
                <Input
                  id={`tunnel-remote-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                  error={!!errors.remoteHost}
                  data-testid="tunnel-editor-remote-host"
                />
              </Field>
              <Field
                label="Remote port"
                htmlFor={`tunnel-remote-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.remotePort}
              >
                <NumberInput
                  id={`tunnel-remote-port-${tabId}`}
                  value={tunnelType.config.remotePort}
                  onValueChange={(v) => updateConfig("remotePort", v)}
                  error={!!errors.remotePort}
                  data-testid="tunnel-editor-remote-port"
                />
              </Field>
            </div>
          </>
        )}

        {tunnelType.type === "remote" && (
          <>
            <span className="tunnel-editor__section-title">Remote Bind (on SSH Server)</span>
            <div className="tunnel-editor__row">
              <Field
                label="Remote host"
                htmlFor={`tunnel-r-remote-host-${tabId}`}
                error={errors.remoteHost}
              >
                <Input
                  id={`tunnel-r-remote-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.remoteHost}
                  onChange={(e) => updateConfig("remoteHost", e.target.value)}
                  error={!!errors.remoteHost}
                  data-testid="tunnel-editor-remote-host"
                />
              </Field>
              <Field
                label="Remote port"
                htmlFor={`tunnel-r-remote-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.remotePort}
              >
                <NumberInput
                  id={`tunnel-r-remote-port-${tabId}`}
                  value={tunnelType.config.remotePort}
                  onValueChange={(v) => updateConfig("remotePort", v)}
                  error={!!errors.remotePort}
                  data-testid="tunnel-editor-remote-port"
                />
              </Field>
            </div>
            <span className="tunnel-editor__section-title">Local target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local host"
                htmlFor={`tunnel-r-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-r-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local port"
                htmlFor={`tunnel-r-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-r-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
          </>
        )}

        {tunnelType.type === "dynamic" && (
          <>
            <span className="tunnel-editor__section-title">SOCKS5 proxy bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local host"
                htmlFor={`tunnel-d-local-host-${tabId}`}
                error={errors.localHost}
              >
                <Input
                  id={`tunnel-d-local-host-${tabId}`}
                  type="text"
                  value={tunnelType.config.localHost}
                  onChange={(e) => updateConfig("localHost", e.target.value)}
                  error={!!errors.localHost}
                />
              </Field>
              <Field
                label="Local port"
                htmlFor={`tunnel-d-local-port-${tabId}`}
                className="tunnel-editor__port-field"
                error={errors.localPort}
              >
                <NumberInput
                  id={`tunnel-d-local-port-${tabId}`}
                  value={tunnelType.config.localPort}
                  onValueChange={(v) => updateConfig("localPort", v)}
                  error={!!errors.localPort}
                  data-testid="tunnel-editor-local-port"
                />
              </Field>
            </div>
          </>
        )}

        <div className="tunnel-editor__checkbox-row">
          <Controller
            name="autoStart"
            control={control}
            render={({ field }) => (
              <Toggle
                id={`auto-start-${tabId}`}
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <label className="tunnel-editor__checkbox-label" htmlFor={`auto-start-${tabId}`}>
            Auto-start when app launches
          </label>
        </div>

        <div className="tunnel-editor__checkbox-row">
          <Controller
            name="startWithConnection"
            control={control}
            render={({ field }) => (
              <Toggle
                id={`start-with-connection-${tabId}`}
                checked={field.value}
                onCheckedChange={field.onChange}
                data-testid="tunnel-editor-start-with-connection"
              />
            )}
          />
          <label
            className="tunnel-editor__checkbox-label"
            htmlFor={`start-with-connection-${tabId}`}
          >
            Start when a session to this SSH connection opens
          </label>
        </div>

        <div className="tunnel-editor__checkbox-row">
          <Controller
            name="reconnectOnDisconnect"
            control={control}
            render={({ field }) => (
              <Toggle
                id={`reconnect-${tabId}`}
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            )}
          />
          <label className="tunnel-editor__checkbox-label" htmlFor={`reconnect-${tabId}`}>
            Reconnect automatically on disconnect
          </label>
        </div>

        <div
          className="tunnel-editor__actions"
          data-testid="tunnel-editor-actions"
          {...TOAST_AVOID_PROPS}
        >
          <Button variant="secondary" onClick={handleCancel} data-testid="tunnel-editor-cancel">
            Cancel
          </Button>
          {/* One primary per footer, on the right (copy style guide). */}
          {!saveAndStartIsPrimary && saveAndStartButton}
          {saveButton}
          {saveAndStartIsPrimary && saveAndStartButton}
        </div>
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
        open={pendingCloseRequest?.tabId === tabId}
        subject="tunnel"
        name={form.name.trim() || undefined}
        onCancel={() => setPendingCloseRequest(null)}
        onJustClose={() => {
          setPendingCloseRequest(null);
          closeThisTab();
        }}
        onSaveAndClose={
          canSave
            ? async () => {
                // Save closes the tab on success; on failure it throws, the
                // Button toasts the error and the prompt stays up.
                await handleSave(false);
                setPendingCloseRequest(null);
              }
            : undefined
        }
      />
    </div>
  );
}
