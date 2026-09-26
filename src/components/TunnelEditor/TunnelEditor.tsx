import { useState, useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
  RunLocation,
  THIS_COMPUTER,
} from "@/types/tunnel";
import { TunnelEditorMeta } from "@/types/terminal";
import { Button, Input, NumberInput, Select, Field, Toggle, toast } from "@/components/ui";
import { useEditorKeyboard } from "@/hooks/useEditorKeyboard";
import { useAutofocusSelect } from "@/hooks/useAutofocusSelect";
import { frontendLog } from "@/utils/frontendLog";
import {
  isAgentHost,
  tunnelEndpointLines,
  tunnelReachabilityWarning,
  WIDE_BIND_HOST,
} from "@/utils/tunnelHost";
import { bestSshViaForAgent, deriveCompanion, findCompanion } from "@/utils/tunnelChain";
import { TunnelDiagram } from "./TunnelDiagram";
import { TunnelChainPreviewDialog } from "./TunnelChainPreviewDialog";
import { validateTunnelType, type TunnelFieldErrors } from "./tunnelValidation";
import { newId } from "@/services/transport/ids";
import "./TunnelEditor.css";

/** Encode a run-location as a `Select` option value, and decode it back. */
const HOST_THIS = "this";
function encodeHost(host: RunLocation): string {
  return isAgentHost(host) ? `agent:${host.agentId}` : HOST_THIS;
}
function decodeHost(value: string): RunLocation {
  return value.startsWith("agent:")
    ? { kind: "agent", agentId: value.slice("agent:".length) }
    : THIS_COMPUTER;
}

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
  sshConnectionId: string;
  tunnelType: TunnelType;
  host: RunLocation;
  autoStart: boolean;
  startWithConnection: boolean;
  reconnectOnDisconnect: boolean;
}

/**
 * Client-side validation schema (UX gate only; the same checks the editor
 * previously ran by hand, translated 1:1 into zod):
 *
 * - `name` must be non-empty once trimmed (UX-022) — gates Save without an
 *   inline error, matching the ConnectionEditor.
 * - `sshConnectionId` must resolve to a saved SSH connection.
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
    sshConnectionId: z.string(),
    tunnelType: z.custom<TunnelType>(),
    host: z.custom<RunLocation>(),
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
  const { connections } = useProjectedConnections();
  const { remoteAgents } = useProjectedAgents();
  const saveTunnel = useAppStore((s) => s.saveTunnel);
  const startTunnel = useAppStore((s) => s.startTunnel);
  const closeTab = useAppStore((s) => s.closeTab);
  const openTunnelEditorTab = useAppStore((s) => s.openTunnelEditorTab);
  const rootPanel = useLayoutRenderTree();

  // Find existing tunnel if editing
  const existingTunnel = meta.tunnelId ? tunnels.find((t) => t.id === meta.tunnelId) : undefined;

  // SSH connections only
  const sshConnections = connections.filter((c) => c.config.type === "ssh");

  const { control, getValues, setValue, reset } = useForm<TunnelFormState>({
    defaultValues: {
      name: existingTunnel?.name ?? "",
      // A new tunnel opened from a connection's "Port Forwarding" section
      // (PROD-023) pre-selects that connection when it is a saved SSH one.
      sshConnectionId:
        existingTunnel?.sshConnectionId ??
        (meta.sshConnectionId && sshConnections.some((c) => c.id === meta.sshConnectionId)
          ? meta.sshConnectionId
          : undefined) ??
        sshConnections[0]?.id ??
        "",
      tunnelType: existingTunnel?.tunnelType ?? defaultTunnelType("local"),
      // Which machine hosts this tunnel (S3, #2155). New tunnels default to This
      // computer — agent hosting is opt-in.
      host: existingTunnel?.host ?? THIS_COMPUTER,
      autoStart: existingTunnel?.autoStart ?? false,
      // Opened from a connection's section: binding it to that connection's
      // sessions is the point, so default the flag on (PROD-023).
      startWithConnection:
        existingTunnel?.startWithConnection ?? (!existingTunnel && !!meta.sshConnectionId),
      reconnectOnDisconnect: existingTunnel?.reconnectOnDisconnect ?? false,
    },
    resolver: zodResolver(tunnelFormSchema),
    mode: "onChange",
  });

  // Sync if the tunnel ID changes (reload the working copy from the store).
  useEffect(() => {
    if (existingTunnel) {
      reset({
        name: existingTunnel.name,
        sshConnectionId: existingTunnel.sshConnectionId,
        tunnelType: existingTunnel.tunnelType,
        host: existingTunnel.host ?? THIS_COMPUTER,
        autoStart: existingTunnel.autoStart,
        startWithConnection: existingTunnel.startWithConnection ?? false,
        reconnectOnDisconnect: existingTunnel.reconnectOnDisconnect,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingTunnel]);

  // Subscribe to every field so validity + the derived diagram/endpoint/
  // reachability reads re-run on each edit, then take a complete, fresh snapshot
  // from `getValues()` (which reflects `setValue` synchronously).
  useWatch({ control });
  const form = getValues();
  // Pull the tagged unions into locals so the `isAgentHost` type guard narrows
  // through into the closures below (control-flow narrowing of a property access
  // does not persist into nested callbacks; a `const` local's does).
  const { tunnelType, host } = form;

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

  // Deterministic, synchronous validity + per-field errors derived straight from
  // the schema — the same approach CustomRuleEditor / EmbeddedServerDialog use.
  const { valid: canSave, errors } = useMemo<{ valid: boolean; errors: TunnelFieldErrors }>(() => {
    const result = tunnelFormSchema.safeParse(form);
    const fieldErrors: TunnelFieldErrors = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[issue.path.length - 1];
        if (typeof key === "string" && !(key in fieldErrors)) fieldErrors[key] = issue.message;
      }
    }
    return { valid: result.success, errors: fieldErrors };
    // `form` is a fresh snapshot every render; key on its serialization so the
    // check only recomputes when a value actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(form)]);

  // Build the parent `TunnelConfig` from the current editor state. Shared by
  // Save and by "Chain a hop" (which must persist the parent before linking a
  // companion to its id). The id is stable across both so chaining a freshly
  // built tunnel links to the same row Save creates.
  const buildConfig = (values: TunnelFormState): TunnelConfig => ({
    id: existingTunnel?.id ?? newId("tun"),
    // Save is disabled while the name is blank (UX-022), so this fallback only
    // ever guards the non-Save caller (chaining a hop).
    name: values.name.trim() || "Untitled Tunnel",
    sshConnectionId: values.sshConnectionId,
    tunnelType: values.tunnelType,
    host: values.host,
    autoStart: values.autoStart,
    startWithConnection: values.startWithConnection,
    reconnectOnDisconnect: values.reconnectOnDisconnect,
    companionOf: existingTunnel?.companionOf,
  });

  const handleSave = async (andStart: boolean) => {
    const config = buildConfig(getValues());

    try {
      await saveTunnel(config);
      if (andStart) {
        startTunnel(config.id).catch((err) => {
          frontendLog("tunnel_editor", `Failed to start tunnel after save: ${err}`);
          toast.error("Failed to start tunnel");
        });
      } else {
        // Plain Save gave no feedback before (UX-022) — the only signal was the
        // tab closing. Confirm it, matching Duplicate/Delete/Start. Save & Start
        // skips this: `startTunnel` owns the feedback for that path.
        toast.success(`Saved tunnel "${config.name}"`);
      }
      // Find panelId for this tab and close it
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) {
        closeTab(tabId, leaf.id);
      }
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to save tunnel: ${err}`);
      throw err instanceof Error ? err : new Error("Failed to save tunnel");
    }
  };

  const handleCancel = async () => {
    const { findLeafByTab } = await import("@/utils/panelTree");
    const leaf = findLeafByTab(rootPanel, tabId);
    if (leaf) {
      closeTab(tabId, leaf.id);
    }
  };

  const sshOptions = sshConnections.map((c) => ({ value: c.id, label: c.name }));

  // Tunnel host (run-location) selector: This computer + every remote agent.
  const hostOptions = [
    { value: HOST_THIS, label: "This computer" },
    ...remoteAgents.map((a) => ({ value: `agent:${a.id}`, label: `Agent · ${a.name}` })),
  ];
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
  const sshViaCandidates = sshConnections.map((c) => ({
    id: c.id,
    host: typeof c.config.config.host === "string" ? c.config.config.host : "",
  }));
  const [chainOpen, setChainOpen] = useState(false);
  const [chainSshId, setChainSshId] = useState("");
  const [chainStartNow, setChainStartNow] = useState(true);

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
      toast.success(`Chained ${parent.name} to this computer`);
      if (chainStartNow) {
        startTunnel(parent.id).catch((err) => {
          frontendLog("tunnel_editor", `Failed to start chained pair: ${err}`);
          toast.error("Failed to start chained pair");
        });
      }
      setChainOpen(false);
      const { findLeafByTab } = await import("@/utils/panelTree");
      const leaf = findLeafByTab(rootPanel, tabId);
      if (leaf) closeTab(tabId, leaf.id);
    } catch (err) {
      frontendLog("tunnel_editor", `Failed to chain hop: ${err}`);
      toast.error("Failed to chain a hop to this computer");
    }
  };

  // The companion the preview describes, derived from the current parent draft.
  const chainCompanion = deriveCompanion(buildConfig(form), chainSshId);
  const chainCompanionLocal =
    chainCompanion.tunnelType.type === "local" ? chainCompanion.tunnelType.config : undefined;

  const nameRef = useAutofocusSelect<HTMLInputElement>();

  // Enter (from a single-line field) saves; Escape cancels.
  const handleKeyDown = useEditorKeyboard({
    onSubmit: () => void handleSave(false),
    onCancel: () => void handleCancel(),
    canSubmit: canSave,
  });

  return (
    <div
      className={`tunnel-editor ${isVisible ? "" : "tunnel-editor--hidden"}`}
      data-testid="tunnel-editor"
      onKeyDown={handleKeyDown}
    >
      <div className="tunnel-editor__header">
        <span className="tunnel-editor__title" data-testid="tunnel-editor-title">
          {existingTunnel ? `Edit Tunnel: ${existingTunnel.name}` : "New SSH Tunnel"}
        </span>
      </div>

      <div className="tunnel-editor__form" data-testid="tunnel-editor-form">
        <Controller
          name="name"
          control={control}
          render={({ field }) => (
            <Field label="Name" htmlFor={`tunnel-name-${tabId}`}>
              <Input
                ref={nameRef}
                id={`tunnel-name-${tabId}`}
                type="text"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                placeholder="e.g. Dev Database"
                data-testid="tunnel-editor-name"
              />
            </Field>
          )}
        />

        <Field label="SSH Connection" htmlFor={`tunnel-ssh-${tabId}`}>
          <Select
            value={form.sshConnectionId || undefined}
            onChange={(v) => setValue("sshConnectionId", v)}
            options={sshOptions}
            placeholder="No SSH connections available"
            aria-label="SSH Connection"
            data-testid="tunnel-editor-ssh-connection"
          />
        </Field>

        <Field label="Tunnel host" htmlFor={`tunnel-host-${tabId}`}>
          <Select
            value={encodeHost(host)}
            onChange={(v) => setValue("host", decodeHost(v))}
            options={hostOptions}
            aria-label="Tunnel host"
            data-testid="tunnel-editor-host"
          />
        </Field>

        <div className="tunnel-editor__field">
          <label className="tunnel-editor__label">Tunnel Type</label>
          <div className="tunnel-editor__type-selector" data-testid="tunnel-editor-type-selector">
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "local" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("local")}
              data-testid="tunnel-type-local"
            >
              <span className="tunnel-editor__type-option-title">Local</span>
              <span className="tunnel-editor__type-option-desc">ssh -L</span>
            </button>
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "remote" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("remote")}
              data-testid="tunnel-type-remote"
            >
              <span className="tunnel-editor__type-option-title">Remote</span>
              <span className="tunnel-editor__type-option-desc">ssh -R</span>
            </button>
            <button
              className={`tunnel-editor__type-option ${tunnelType.type === "dynamic" ? "tunnel-editor__type-option--active" : ""}`}
              onClick={() => handleTypeChange("dynamic")}
              data-testid="tunnel-type-dynamic"
            >
              <span className="tunnel-editor__type-option-title">Dynamic</span>
              <span className="tunnel-editor__type-option-desc">ssh -D (SOCKS5)</span>
            </button>
          </div>
        </div>

        <TunnelDiagram tunnelType={tunnelType} />

        <div className="tunnel-editor__endpoints" data-testid="tunnel-editor-endpoints">
          <div className="tunnel-editor__endpoints-host">
            {isAgentHost(host) ? <Server size={13} /> : <Monitor size={13} />}
            <span>
              Host:{" "}
              <strong>{isAgentHost(host) ? `agent ${hostAgentName}` : "this computer"}</strong>
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
            <span className="tunnel-editor__section-title">Local Bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
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
                label="Local Port"
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
            <span className="tunnel-editor__section-title">Remote Target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Remote Host"
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
                label="Remote Port"
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
                label="Remote Host"
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
                label="Remote Port"
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
            <span className="tunnel-editor__section-title">Local Target</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
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
                label="Local Port"
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
            <span className="tunnel-editor__section-title">SOCKS5 Proxy Bind</span>
            <div className="tunnel-editor__row">
              <Field
                label="Local Host"
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
                label="Local Port"
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

        <div className="tunnel-editor__actions">
          <Button
            variant="primary"
            onClick={() => handleSave(false)}
            disabled={!canSave}
            data-testid="tunnel-editor-save"
          >
            Save
          </Button>
          <Button
            variant="primary"
            onClick={() => handleSave(true)}
            disabled={!canSave}
            data-testid="tunnel-editor-save-start"
          >
            Save &amp; Start
          </Button>
          <Button variant="secondary" onClick={handleCancel} data-testid="tunnel-editor-cancel">
            Cancel
          </Button>
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
    </div>
  );
}
