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
import type { EmbeddedServerConfig, ServerState, ServerType } from "@/types/embeddedServer";
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
  tunnelServiceState,
  type ServiceRunAction,
  type ServiceState,
} from "@/utils/serviceState";
import { shareTypeHelp } from "@/utils/shareTypeHelp";
import { isAgentHost } from "@/utils/tunnelHost";
import { tunnelTypeHelp, type TunnelTypeKind } from "@/utils/tunnelTypeHelp";

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
export interface ServiceNextStep {
  id: "chooseConnection";
  label: string;
}

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
  where: ServiceWhere;
  /** What it is, and where when that is not this computer, as one line. */
  kindLine: string;
  state: ServiceState;
  /** Why it is in that state, when the user needs to know. */
  reason?: string;
  nextStep?: ServiceNextStep;
  /** Only while it runs. */
  address?: ServiceAddress;
  /** Only while it runs. */
  counters?: ServiceCounters;
  /** What it offers now, always in this order. */
  actions: ServiceAction[];
}

/** What a model needs besides the service itself. */
export interface ServiceContext {
  agents: readonly Pick<RemoteAgentDefinition, "id" | "name" | "config">[];
  connections: readonly SavedConnection[];
  /** This computer's address on the network, when known. */
  networkAddress?: string;
}

/** The one order of actions, in buttons, menus and Activity. */
export const SERVICE_ACTION_ORDER: readonly ServiceActionId[] = [
  "start",
  "stop",
  "stopWaiting",
  "retry",
  "copyAddress",
  "openInBrowser",
  "activity",
  "edit",
  "restart",
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

function serviceActions(kind: ServiceKind, offered: ReadonlySet<ServiceActionId>): ServiceAction[] {
  return SERVICE_ACTION_ORDER.filter((id) => offered.has(id)).map((id) => {
    const label = t(
      id === "restart" && kind === "tunnel" ? "service.action.reconnect" : ACTION_LABELS[id]
    );
    return { id, label, shortcut: SHORTCUTS[id] };
  });
}

/** What every kind offers in `state`. */
function offeredIn(state: ServiceState, address: ServiceAddress | undefined): Set<ServiceActionId> {
  const offered = new Set<ServiceActionId>(["edit", "duplicate", "delete"]);
  const run = serviceRunAction(state);
  if (run) offered.add(run);
  if (address) offered.add("copyAddress");
  if (state === "running") offered.add("restart");
  return offered;
}

function whereOf(host: HostChoice, agents: ServiceContext["agents"]): ServiceWhere {
  if (host.kind === "unreadable") return { label: t("service.where.unknown") };
  if (!isAgentHost(host)) return { label: t("service.where.here") };
  const agent = agents.find((a) => a.id === host.agentId);
  return {
    label: agent
      ? tf("service.where.agent", { agent: agent.name })
      : t("service.where.agentRemoved"),
    agentId: host.agentId,
  };
}

/** The machine that listens for a service hosted on `host`. */
function listenerOn(host: HostChoice, context: ServiceContext): Listener {
  if (!isAgentHost(host)) return { on: "here", network: context.networkAddress };
  const agent = context.agents.find((a) => a.id === host.agentId);
  return { on: "there", name: agent?.name ?? host.agentId, host: agent?.config?.host };
}

function kindLine(what: string, host: HostChoice, where: ServiceWhere): string {
  return host.kind === "thisComputer" ? what : tf("service.kindLine", { what, where: where.label });
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
    const name = connection?.name ?? "SSH server";
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

/** The model of a tunnel. */
export function tunnelModel(
  config: TunnelConfig,
  state: TunnelState | undefined,
  context: ServiceContext
): ServiceModel {
  const host = hostChoice(config.host);
  const where = whereOf(host, context.agents);
  const type = config.tunnelType.type;
  const what = tunnelTypeHelp(type, host).summary;
  const serviceState = tunnelServiceState(state?.status);
  const running = serviceState === "running";
  const address = running ? tunnelAddress(config, state, host, context) : undefined;
  const needsConnection = serviceState === "needsConnection";
  const stats = running ? state?.stats : undefined;
  return {
    id: config.id,
    kind: "tunnel",
    type,
    name: config.name,
    description: config.description,
    what,
    where,
    kindLine: kindLine(what, host, where),
    state: serviceState,
    reason: needsConnection
      ? t("service.reason.needsConnection")
      : serviceReason(serviceState, state?.error),
    nextStep: needsConnection
      ? { id: "chooseConnection", label: t("service.next.chooseConnection") }
      : undefined,
    address,
    counters: stats && {
      sent: stats.bytesSent,
      received: stats.bytesReceived,
      active: stats.activeConnections,
      total: stats.totalConnections,
    },
    actions: serviceActions("tunnel", offeredIn(serviceState, address)),
  };
}

/** The model of a file server. */
export function fileServerModel(
  config: EmbeddedServerConfig,
  state: ServerState | undefined,
  context: ServiceContext
): ServiceModel {
  const host = hostChoice(config.host);
  const where = whereOf(host, context.agents);
  const what = shareTypeHelp(config.serverType, host).summary;
  const serviceState = serverServiceState(state?.status);
  const running = serviceState === "running";
  const address = running
    ? serviceAddress(
        config.bindHost,
        config.port,
        listenerOn(host, context),
        `${config.serverType}://`
      )
    : undefined;
  const offered = offeredIn(serviceState, address);
  offered.add("activity");
  // Not for one that opens elsewhere: the browser here would find another localhost.
  if (address && !address.on && config.serverType === "http") offered.add("openInBrowser");
  const stats = running ? state?.stats : undefined;
  return {
    id: config.id,
    kind: "fileServer",
    type: config.serverType,
    name: config.name,
    description: config.description,
    what,
    where,
    kindLine: kindLine(what, host, where),
    state: serviceState,
    reason: serviceReason(serviceState, state?.error),
    address,
    counters: stats && {
      sent: stats.bytesSent,
      received: stats.bytesReceived,
      active: stats.activeConnections,
      total: stats.totalConnections,
    },
    actions: serviceActions("fileServer", offered),
  };
}
