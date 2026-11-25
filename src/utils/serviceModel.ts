/**
 * One model for both kinds of service, SSH tunnels and file servers (#6028):
 * what a row, a menu and (later) Activity show and offer. Pure, so every state
 * of every kind is a table test.
 *
 * Components render this and nothing else about a service; words, order and
 * rules live here.
 */
import { t, tf, type MessageId } from "@/i18n/catalog";
import type { RemoteAgentDefinition, SavedConnection } from "@/types/connection";
import {
  PROTOCOL_LABELS,
  type EmbeddedServerConfig,
  type ServerState,
  type ServerType,
} from "@/types/embeddedServer";
import type { ServiceCause } from "@/types/generated/ServiceCause";
import type { TunnelConfig, TunnelState } from "@/types/tunnel";
import { hostChoice, type HostChoice } from "@/utils/hostChoice";
import {
  serviceAddress,
  splitHostPort,
  type Listener,
  type ServiceAddress,
} from "@/utils/serviceAddress";
import {
  serverServiceState,
  serviceReason,
  serviceRunAction,
  serviceStateDot,
  serviceStateLabel,
  tunnelServiceState,
  type ServiceRunAction,
  type ServiceState,
} from "@/utils/serviceState";
import { hasHopName, type PairStatus } from "@/utils/tunnelChain";
import { isAgentHost, isLoopbackBind } from "@/utils/tunnelHost";
import { tunnelTypeLabel, type TunnelTypeKind } from "@/utils/tunnelTypeHelp";

export type ServiceKind = "tunnel" | "fileServer";

/** Everything a service may offer, besides its next step. */
export type ServiceActionId =
  | ServiceRunAction
  | "copyAddress"
  | "openInBrowser"
  | "activity"
  | "edit"
  | "restart"
  | "duplicate"
  | "delete";

/** One thing to do with a service. */
export interface ServiceAction {
  id: ServiceActionId;
  /** The word on every surface, and the button's accessible name. */
  label: string;
  /** The key on the focused row, as `aria-keyshortcuts` writes it. */
  shortcut?: string;
}

/** What helps when a service cannot simply be started. */
export type ServiceNextStepId =
  | "chooseConnection"
  | "usePort"
  | "edit"
  | "connectAgent"
  | "checkAgain"
  | "keepRunning"
  | "letReach"
  | "chooseMachine"
  | "unlock"
  | "editConnection"
  | "retryNow";

/** The remedy for the reason beside it. */
export interface ServiceNextStep {
  id: ServiceNextStepId;
  label: string;
  /** `usePort`: which one. */
  port?: number;
}

/** How a service counts in a list; `quiet` ones are off, starting or stopping. */
export type ServiceHealth = "running" | "error" | "notKnown" | "reconnecting" | "waiting" | "quiet";

/** Traffic of a running service. */
export interface ServiceCounters {
  sent: number;
  received: number;
  active: number;
  total: number;
}

/** Where a service runs. */
export interface ServiceWhere {
  /** `this computer`, `agent Build box`, … */
  label: string;
  /** On an agent, reachable or not. */
  agentId?: string;
  /** The agent's name, when it is known. */
  name?: string;
  /** That agent was removed. */
  removed?: boolean;
}

export interface ServiceModel {
  id: string;
  kind: ServiceKind;
  /** The technical type: `local`, `remote`, `dynamic`, `http`, `ftp`, `tftp`. */
  type: TunnelTypeKind | ServerType;
  name: string;
  description?: string;
  /** What it is for, in plain words: "Open a folder in a browser". */
  what: string;
  /** The technical name of what it is: "Local", "FTP". */
  technical: string;
  where: ServiceWhere;
  /** The machine as the row names it; not this computer. */
  machine?: string;
  state: ServiceState;
  health: ServiceHealth;
  /** The word for the state. */
  stateLabel: string;
  dot: ReturnType<typeof serviceStateDot>;
  /** Why it is in that state, when the user needs to know. */
  reason?: string;
  /** What helps with the reason, the best first. */
  nextSteps: ServiceNextStep[];
  /** What others may do to it that the user should know. */
  risk?: string;
  /** Only while it runs. */
  address?: ServiceAddress;
  /** What helps when nobody it is for reaches that address. */
  addressStep?: ServiceNextStep;
  /** Only while it runs. */
  counters?: ServiceCounters;
  /** What it offers now, always in this order. */
  actions: ServiceAction[];
}

/** What a model needs besides the service itself. */
export interface ServiceContext {
  agents: readonly (Pick<RemoteAgentDefinition, "id" | "name" | "config"> &
    Partial<Pick<RemoteAgentDefinition, "connectionState">>)[];
  /** Whether `agents` is known yet; before that, none of them is missing. */
  agentsKnown?: boolean;
  connections: readonly SavedConnection[];
  /** This computer's address on the network, when known. */
  networkAddress?: string;
  /** The ports that services of this computer use. */
  usedPorts?: ReadonlySet<number>;
  /** Which service of this computer has a port open now. */
  portHolders?: ReadonlyMap<number, { id: string; name: string }>;
}

/** The part of a chained pair that a tunnel is (#2597). */
export interface ServiceChain {
  role: "parent" | "hop";
  status: PairStatus;
}

/** The one order of actions, in buttons, menus and Activity. */
export const SERVICE_ACTION_ORDER: readonly ServiceActionId[] = [
  "start",
  "stop",
  "stopWaiting",
  "retry",
  "restart",
  "copyAddress",
  "openInBrowser",
  "activity",
  "edit",
  "duplicate",
  "delete",
];

const ACTION_LABELS: Record<ServiceActionId, MessageId> = {
  start: "service.action.start",
  stop: "service.action.stop",
  stopWaiting: "service.action.stopWaiting",
  retry: "service.action.retry",
  copyAddress: "service.action.copyAddress",
  openInBrowser: "service.action.openInBrowser",
  activity: "service.action.activity",
  edit: "service.action.edit",
  restart: "service.action.restart",
  duplicate: "service.action.duplicate",
  delete: "service.action.delete",
};

/** Keys on the focused row. The run action, whichever it is now, is Space. */
const SHORTCUTS: Partial<Record<ServiceActionId, string>> = {
  start: "Space",
  stop: "Space",
  stopWaiting: "Space",
  retry: "Space",
  edit: "Enter",
  delete: "Delete",
};

function serviceActions(
  state: ServiceState,
  offered: ReadonlySet<ServiceActionId>
): ServiceAction[] {
  return SERVICE_ACTION_ORDER.filter((id) => offered.has(id)).map((id) => {
    const cancels = id === "stop" && state === "starting";
    const label = t(cancels ? "service.action.cancelStart" : ACTION_LABELS[id]);
    return { id, label, shortcut: SHORTCUTS[id] };
  });
}

const HEALTH: Record<ServiceState, ServiceHealth> = {
  stopped: "quiet",
  waiting: "waiting",
  starting: "quiet",
  running: "running",
  reconnecting: "reconnecting",
  stopping: "quiet",
  error: "error",
  needsConnection: "error",
  notReachable: "notKnown",
};

/** What every kind offers in `state`. */
function offeredIn(state: ServiceState, address: ServiceAddress | undefined): Set<ServiceActionId> {
  const offered = new Set<ServiceActionId>(["edit", "duplicate", "delete"]);
  const run = serviceRunAction(state);
  if (run) offered.add(run);
  if (address?.copy) offered.add("copyAddress");
  if (state === "running") offered.add("restart");
  return offered;
}

/** The next port after `port` that no service here is set to. */
function nextFreePort(port: number, context: ServiceContext): number | undefined {
  for (let next = port + 1; next <= 65535; next += 1) {
    if (!context.usedPorts?.has(next)) return next;
  }
  return undefined;
}

/** What helps with `cause` in `state`; `port` is the one it listens on here. */
function nextStepsFor(
  state: ServiceState,
  cause: ServiceCause | undefined,
  where: ServiceWhere,
  port: number | undefined,
  context: ServiceContext
): ServiceNextStep[] {
  if (state === "needsConnection") {
    return [{ id: "chooseConnection", label: t("service.next.chooseConnection") }];
  }
  if (state === "reconnecting") return [{ id: "retryNow", label: t("service.next.retryNow") }];
  if (where.removed) return [{ id: "chooseMachine", label: t("service.next.chooseMachine") }];
  switch (cause) {
    case "portInUse": {
      const edit: ServiceNextStep = { id: "edit", label: t("service.next.edit") };
      const next = port === undefined ? undefined : nextFreePort(port, context);
      return next === undefined
        ? [edit]
        : [
            {
              id: "usePort",
              label: tf("service.next.usePort", { port: String(next) }),
              port: next,
            },
            edit,
          ];
    }
    case "agentOffline": {
      const agent = context.agents.find((a) => a.id === where.agentId);
      // One on its way needs no help.
      const helps = agent && (agent.connectionState ?? "disconnected") === "disconnected";
      const steps: ServiceNextStep[] = [];
      if (state === "stopping") {
        steps.push({ id: "keepRunning", label: t("service.next.keepRunning") });
      }
      if (helps) steps.push({ id: "connectAgent", label: t("service.next.connectAgent") });
      return steps;
    }
    case "agentSilent":
      return [{ id: "checkAgain", label: t("service.next.checkAgain") }];
    case "storeLocked":
      return [{ id: "unlock", label: t("service.next.unlock") }];
    case "connection":
      return [{ id: "editConnection", label: t("service.next.editConnection") }];
    default:
      return [];
  }
}

/** State, words, reason and remedies: the same for both kinds. */
function stateParts(
  reportedState: ServiceState,
  reported: { error?: string; cause?: ServiceCause } | undefined,
  where: ServiceWhere,
  port: number | undefined,
  context: ServiceContext
): Pick<ServiceModel, "state" | "stateLabel" | "dot" | "health" | "reason" | "nextSteps"> {
  // Nobody can say that it runs on a machine termiHub no longer talks to.
  const lost = where.removed && reportedState === "running";
  const state = lost ? "notReachable" : reportedState;
  // The stop is owed, not under way: it may still run for a long time.
  const pending = state === "stopping" && reported?.cause === "agentOffline";
  const stateLabel = pending ? t("service.state.stopPending") : serviceStateLabel(state);
  const dot = serviceStateDot(state);
  const holder =
    reported?.cause === "portInUse" && port !== undefined
      ? context.portHolders?.get(port)
      : undefined;
  const reason = lost
    ? t("service.reason.agentRemoved")
    : state === "needsConnection"
      ? t("service.reason.needsConnection")
      : holder && serviceReason(state, reported?.error)
        ? tf("service.reason.portHeld", { port: String(port), name: holder.name })
        : serviceReason(state, reported?.error);
  return {
    state,
    stateLabel,
    dot: { ...dot, label: stateLabel, title: stateLabel, pulse: dot.pulse && !pending },
    health: pending ? "notKnown" : HEALTH[state],
    reason,
    nextSteps: reason ? nextStepsFor(state, reported?.cause, where, port, context) : [],
  };
}

function whereOf(host: HostChoice, { agents, agentsKnown = true }: ServiceContext): ServiceWhere {
  if (host.kind === "unreadable") return { label: t("service.where.unknown") };
  if (!isAgentHost(host)) return { label: t("service.where.here") };
  const agent = agents.find((a) => a.id === host.agentId);
  if (agent) {
    const label = tf("service.where.agent", { agent: agent.name });
    return { label, agentId: host.agentId, name: agent.name };
  }
  return agentsKnown
    ? { label: t("service.where.agentRemoved"), agentId: host.agentId, removed: true }
    : { label: t("service.where.agentUnknown"), agentId: host.agentId };
}

/** How the row names the machine of a service that does not run here. */
function machineOf(where: ServiceWhere, host: HostChoice): string | undefined {
  return host.kind === "thisComputer" ? undefined : (where.name ?? where.label);
}

/** The offline agent that keeps `model` from working, if that is what does. */
export function offlineAgentOf(model: ServiceModel): string | undefined {
  return model.nextSteps.some((step) => step.id === "connectAgent")
    ? model.where.agentId
    : undefined;
}

/**
 * `model` for a row under the line of its offline agent (#6028): the line names
 * the agent, says that it is offline, and connects it.
 */
export function withoutAgent(model: ServiceModel): ServiceModel {
  return {
    ...model,
    machine: undefined,
    reason:
      model.state === "notReachable"
        ? undefined
        : model.state === "stopping"
          ? t("service.reason.stopPending.short")
          : model.reason,
    nextSteps: model.nextSteps.filter((step) => step.id !== "connectAgent"),
  };
}

/** The machine that listens for a service hosted on `host`. */
function listenerOn(host: HostChoice, context: ServiceContext): Listener {
  if (!isAgentHost(host)) return { on: "here", network: context.networkAddress };
  const agent = context.agents.find((a) => a.id === host.agentId);
  return {
    on: "there",
    name: agent?.name ?? host.agentId,
    host: agent?.config?.host || undefined,
    shown: true,
  };
}

/** The name of a target, unless it is the machine itself. */
function targetName(host: string): string | undefined {
  const name = host.trim();
  return name === "" || isLoopbackBind(name) ? undefined : name;
}

/** What a tunnel is for, by the names of its ends. */
function tunnelPurpose(config: TunnelConfig, host: HostChoice, context: ServiceContext): string {
  const connection = context.connections.find((c) => c.id === config.sshConnectionId);
  const server = connection?.name ?? t("service.what.unknownServer");
  switch (config.tunnelType.type) {
    case "local": {
      const target = targetName(config.tunnelType.config.remoteHost);
      return target
        ? tf("service.what.local", { target, server })
        : tf("service.what.local.server", { server });
    }
    case "remote": {
      const target = targetName(config.tunnelType.config.localHost);
      if (target) return tf("service.what.remote.target", { server, target });
      return tf(
        host.kind === "thisComputer" ? "service.what.remote" : "service.what.remote.there",
        { server }
      );
    }
    case "dynamic":
      return tf("service.what.dynamic", { server });
  }
}

/** What others can do with a file server, as it is set. */
function fileServerPurpose(config: EmbeddedServerConfig): string {
  switch (config.serverType) {
    case "http":
      return t("service.what.http");
    case "ftp":
      return t(config.readOnly ? "service.what.ftp.readOnly" : "service.what.ftp.write");
    case "tftp":
      return t(config.readOnly ? "service.what.tftp.readOnly" : "service.what.tftp.write");
  }
}

/** Whether it asks for a password. */
function asksForPassword(config: EmbeddedServerConfig): boolean {
  switch (config.serverType) {
    case "http":
      return config.httpAuth !== undefined;
    case "ftp":
      return config.ftpAuth?.type === "credentials";
    case "tftp":
      return false;
  }
}

/** Whether whoever reaches it may put files there, without signing in. */
function anyoneMayUpload(config: EmbeddedServerConfig): boolean {
  if (config.serverType === "http" || config.readOnly) return false;
  return !asksForPassword(config);
}

/** The address of a running tunnel: where others connect to it. */
function tunnelAddress(
  config: TunnelConfig,
  state: TunnelState | undefined,
  host: HostChoice,
  context: ServiceContext
): ServiceAddress | undefined {
  const { tunnelType } = config;
  if (tunnelType.type === "remote") {
    // It listens on the SSH server, whoever hosts it.
    const connection = context.connections.find((c) => c.id === config.sshConnectionId);
    const server = connection?.config.config as { host?: unknown } | undefined;
    const name = connection?.name ?? t("service.what.unknownServer");
    const listener: Listener = {
      on: "there",
      name,
      host: typeof server?.host === "string" && server.host !== "" ? server.host : undefined,
    };
    return serviceAddress(tunnelType.config.remoteHost, tunnelType.config.remotePort, listener);
  }
  // An agent says where it really bound.
  const bound = state?.boundAddress ? splitHostPort(state.boundAddress) : undefined;
  return serviceAddress(
    bound?.host ?? tunnelType.config.localHost,
    bound?.port ?? tunnelType.config.localPort,
    listenerOn(host, context),
    tunnelType.type === "dynamic" ? "socks5://" : ""
  );
}

/** The port a tunnel listens on here, if it does. */
function localPortOf(config: TunnelConfig, host: HostChoice): number | undefined {
  if (host.kind !== "thisComputer" || config.tunnelType.type === "remote") return undefined;
  const { localPort } = config.tunnelType.config;
  return typeof localPort === "number" ? localPort : undefined;
}

/** The model of a tunnel; `chain` when it is one half of a chained pair. */
export function tunnelModel(
  config: TunnelConfig,
  state: TunnelState | undefined,
  context: ServiceContext,
  chain?: ServiceChain
): ServiceModel {
  const host = hostChoice(config.host);
  const where = whereOf(host, context);
  const type = config.tunnelType.type;
  const parts = stateParts(
    tunnelServiceState(state?.status),
    state,
    where,
    localPortOf(config, host),
    context
  );
  const running = parts.state === "running";
  const address = running ? tunnelAddress(config, state, host, context) : undefined;
  const stats = running ? state?.stats : undefined;
  // It runs there, but what the pair is for, using it here, does not work.
  const halfWay = chain?.role === "parent" && chain.status === "degraded";
  const offered = offeredIn(parts.state, address);
  // Pasted here, it would reach whatever listens on that port of this computer.
  if (halfWay) offered.delete("copyAddress");
  return {
    ...parts,
    ...(halfWay
      ? { dot: { ...parts.dot, tone: "warning" }, reason: t("service.chain.notHere") }
      : {}),
    id: config.id,
    kind: "tunnel",
    type,
    name: chain?.role === "hop" && hasHopName(config) ? t("service.chain.hopName") : config.name,
    description: config.description,
    what: chain?.role === "hop" ? t("service.chain.hopWhat") : tunnelPurpose(config, host, context),
    technical: tunnelTypeLabel(type),
    where,
    machine: machineOf(where, host),
    address,
    counters: stats && {
      sent: stats.bytesSent,
      received: stats.bytesReceived,
      active: stats.activeConnections,
      total: stats.totalConnections,
    },
    actions: serviceActions(parts.state, offered),
  };
}

/** The address of a running file server, and who may use it. */
function serverAddress(
  config: EmbeddedServerConfig,
  host: HostChoice,
  context: ServiceContext
): ServiceAddress | undefined {
  const listener = listenerOn(host, context);
  const scheme = `${config.serverType}://`;
  const address = serviceAddress(config.bindHost, config.port, listener, scheme);
  // A device is never this computer.
  if (address && !address.open && config.serverType === "tftp") {
    const here = host.kind === "thisComputer";
    const reach = t(here ? "service.reach.noDevice" : "service.reach.noDeviceThere");
    return { ...address, reach };
  }
  if (!address?.open || !address.copy || !asksForPassword(config)) return address;
  const here = host.kind === "thisComputer";
  return {
    ...address,
    reach: t(here ? "service.reach.network.password" : "service.reach.anyoneThere.password"),
  };
}

/** The model of a file server. */
export function fileServerModel(
  config: EmbeddedServerConfig,
  state: ServerState | undefined,
  context: ServiceContext
): ServiceModel {
  const host = hostChoice(config.host);
  const where = whereOf(host, context);
  const port = host.kind === "thisComputer" ? config.port : undefined;
  const parts = stateParts(serverServiceState(state?.status), state, where, port, context);
  const running = parts.state === "running";
  const address = running ? serverAddress(config, host, context) : undefined;
  const offered = offeredIn(parts.state, address);
  offered.add("activity");
  // Not for one that opens elsewhere: the browser here would find another localhost.
  if (address?.copy && !address.on && config.serverType === "http") offered.add("openInBrowser");
  const stats = running ? state?.stats : undefined;
  return {
    ...parts,
    id: config.id,
    kind: "fileServer",
    type: config.serverType,
    name: config.name,
    description: config.description,
    what: fileServerPurpose(config),
    technical: PROTOCOL_LABELS[config.serverType],
    where,
    machine: machineOf(where, host),
    risk:
      address?.open && anyoneMayUpload(config)
        ? t(host.kind === "thisComputer" ? "service.risk.upload.here" : "service.risk.upload.there")
        : undefined,
    address,
    addressStep:
      address && !address.open && config.serverType === "tftp"
        ? { id: "letReach", label: t("service.next.letReach") }
        : undefined,
    counters: stats && {
      sent: stats.bytesSent,
      received: stats.bytesReceived,
      active: stats.activeConnections,
      total: stats.totalConnections,
    },
    actions: serviceActions(parts.state, offered),
  };
}

/** One number of a list, and the rows behind it. */
export interface ServiceCount {
  id: Exclude<ServiceHealth, "quiet">;
  label: string;
}

/** What needs a look, the most urgent first. */
const COUNTED = ["error", "notKnown", "reconnecting", "waiting"] as const;

/** "2 errors", "1 waiting"; that all of them only need a connection is said so. */
export function serviceCountLabel(
  id: (typeof COUNTED)[number],
  models: readonly Pick<ServiceModel, "health" | "state">[]
): string {
  const own = models.filter((model) => model.health === id);
  const count = String(own.length);
  const one = own.length === 1;
  switch (id) {
    case "error":
      if (own.every((model) => model.state === "needsConnection")) {
        return one
          ? t("service.counts.needsConnection.one")
          : tf("service.counts.needsConnection", { count });
      }
      return one ? t("service.counts.error.one") : tf("service.counts.error", { count });
    case "notKnown":
      return tf("service.counts.notKnown", { count });
    case "reconnecting":
      return tf("service.counts.reconnecting", { count });
    case "waiting":
      return tf("service.counts.waiting", { count });
  }
}

/** The numbers of a list that are not simply running or off. */
export function serviceProblems(
  models: readonly Pick<ServiceModel, "health" | "state">[]
): ServiceCount[] {
  return COUNTED.filter((id) => models.some((model) => model.health === id)).map((id) => ({
    id,
    label: serviceCountLabel(id, models),
  }));
}

/** "7 of 15 running". */
export function serviceRunningLabel(models: readonly Pick<ServiceModel, "health">[]): string {
  return tf("service.counts.running", {
    running: String(models.filter((model) => model.health === "running").length),
    total: String(models.length),
  });
}

/** How many of a list run, and how many are in each state that is not simply on or off. */
export function serviceCounts(
  models: readonly Pick<ServiceModel, "health" | "state">[]
): ServiceCount[] {
  return [{ id: "running", label: serviceRunningLabel(models) }, ...serviceProblems(models)];
}
