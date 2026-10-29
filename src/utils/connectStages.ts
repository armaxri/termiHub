import type { ConnectStage as BackendStage } from "@/types/generated/ConnectStage";
import type { ConnectStage as StepperStage } from "@/components/ui/ConnectProgress";

/**
 * Connect-stage model for the shared connect overlay (#5068): which steps each
 * connection type goes through, how they are labelled, and how a backend
 * `connect-progress` report (or the frontend's own agent / local knowledge)
 * maps onto the stepper.
 */

/** A step id: a backend {@link BackendStage} or a frontend-only step. */
export type StepId = BackendStage | "agent" | "start";

/** Stepper labels, in display language. */
const LABELS: Record<StepId, string> = {
  resolve: "Resolve",
  connect: "Connect",
  hostKey: "Host key",
  authenticate: "Authenticate",
  shell: "Shell",
  openPort: "Open port",
  session: "Session",
  agent: "Agent",
  start: "Start session",
};

/** The ordered steps a connect of `sessionType` goes through. */
export function stepsFor(sessionType: string, viaAgent = false): StepId[] {
  if (viaAgent) return ["agent", "start"];
  switch (sessionType) {
    case "ssh":
      return ["resolve", "connect", "hostKey", "authenticate", "shell"];
    case "telnet":
      return ["resolve", "connect", "session"];
    case "serial":
      return ["openPort", "session"];
    default:
      // Local shells, WSL, Docker and plugin types report no stages: one short
      // step that is active until the session is up.
      return ["start"];
  }
}

/**
 * Build the stepper for `steps` with `current` reached. Steps before it are
 * done, `current` is active (or failed when `failed`), later ones pending. An
 * unknown / absent `current` makes the first step the active one.
 */
export function buildStages(
  steps: StepId[],
  current: StepId | undefined,
  failed = false
): StepperStage[] {
  const at = Math.max(0, current ? steps.indexOf(current) : 0);
  return steps.map((id, i) => ({
    id,
    label: LABELS[id],
    state: i < at ? "done" : i > at ? "pending" : failed ? "failed" : "active",
  }));
}

/** Display label for a connection type. */
export function connectTypeLabel(sessionType: string): string {
  switch (sessionType) {
    case "ssh":
      return "SSH";
    case "telnet":
      return "Telnet";
    case "serial":
      return "Serial";
    case "local":
      return "Local shell";
    case "wsl":
      return "WSL";
    case "docker":
      return "Docker";
    case "rdp":
      return "RDP";
    case "vnc":
      return "VNC";
    case "sftp":
      return "SFTP";
    case "":
      return "Terminal";
    default:
      return sessionType.charAt(0).toUpperCase() + sessionType.slice(1);
  }
}

/** The tab id a `connectId` (`${tabId}:${retryCount}`) belongs to. */
export function tabIdFromConnectId(connectId: string): string | null {
  const cut = connectId.lastIndexOf(":");
  return cut > 0 ? connectId.slice(0, cut) : null;
}

/** What a connection's config says about where it connects to. */
export interface ConnectTarget {
  /** Host / port path, when the config has one. */
  target?: string;
  /** Extra chips: port, baud rate, jump host. */
  details: string[];
}

/** Read the target and detail chips from a connection's `config` object. */
export function connectTargetOf(sessionType: string, config: unknown): ConnectTarget {
  const c = (config ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === "string" && c[k] !== "" ? (c[k] as string) : "");
  const num = (k: string) =>
    typeof c[k] === "number" || (typeof c[k] === "string" && c[k] !== "") ? String(c[k]) : "";
  switch (sessionType) {
    case "ssh":
    case "telnet": {
      const details: string[] = [];
      if (num("port")) details.push(`port ${num("port")}`);
      const hops = (Array.isArray(c.proxyJump) ? c.proxyJump : c.jumpHosts) as
        | Array<{ host?: string }>
        | undefined;
      const firstHop = Array.isArray(hops) ? hops[0]?.host?.trim() : undefined;
      if (sessionType === "ssh" && firstHop) {
        details.push(
          hops && hops.length > 1 ? `via ${firstHop} +${hops.length - 1}` : `via ${firstHop}`
        );
      }
      return { target: str("host") || undefined, details };
    }
    case "serial":
      return {
        target: str("port") || undefined,
        details: num("baudRate") ? [`${num("baudRate")} baud`] : [],
      };
    default:
      return { details: [] };
  }
}

/** Connect-overlay props derived from a tab's connection config. */
export interface ConnectOverlayIdentity extends ConnectTarget {
  /** The effective type (the inner type of an agent session). */
  sessionType: string;
  /** The session runs on a remote agent. */
  viaAgent: boolean;
}

/** Derive the connect overlay's type / target / chips from a tab's config. */
export function connectOverlayIdentity(config: {
  type: string;
  config?: unknown;
}): ConnectOverlayIdentity {
  const viaAgent = config.type === "remote-session";
  const inner = (config.config ?? {}) as Record<string, unknown>;
  const sessionType = viaAgent
    ? typeof inner.sessionType === "string"
      ? inner.sessionType
      : ""
    : config.type;
  return { sessionType, viaAgent, ...connectTargetOf(sessionType, config.config) };
}
