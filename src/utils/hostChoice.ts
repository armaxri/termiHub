/**
 * Which machine a saved service (file server, SSH tunnel) runs on, as stored
 * (#6028). Reads a raw host the way core's `util/service_host.rs` does: an
 * absent one is this computer, and anything this build does not know is
 * **unreadable**, never this computer. The backend does not start a service
 * with an unreadable host, so the UI must not show it as running here either.
 */
import type { RunLocation } from "@/types/tunnel";
import { THIS_COMPUTER } from "@/types/tunnel";

/** A host this build cannot read. */
export interface UnreadableHost {
  kind: "unreadable";
}

/** Where a service runs, or that this build cannot tell. */
export type HostChoice = RunLocation | UnreadableHost;

/** The one {@link UnreadableHost} value. */
export const UNREADABLE_HOST: UnreadableHost = { kind: "unreadable" };

/** Read a stored `host` field. */
export function hostChoice(raw: unknown): HostChoice {
  if (raw === undefined) return THIS_COMPUTER;
  if (typeof raw !== "object" || raw === null) return UNREADABLE_HOST;
  const host = raw as Record<string, unknown>;
  const keys = Object.keys(host).length;
  if (host.kind === "thisComputer" && keys === 1) return THIS_COMPUTER;
  if (
    host.kind === "agent" &&
    keys === 2 &&
    typeof host.agentId === "string" &&
    host.agentId !== ""
  ) {
    return { kind: "agent", agentId: host.agentId };
  }
  return UNREADABLE_HOST;
}

/** Whether two hosts are the same machine. */
export function sameHost(a: HostChoice, b: HostChoice): boolean {
  if (a.kind === "agent" && b.kind === "agent") return a.agentId === b.agentId;
  return a.kind === b.kind;
}
