import type { ConnectStage } from "@/components/ui/ConnectProgress";
import type { ConnectionConfig } from "@/types/terminal";
import { readConfigBoolean, readConfigString } from "@/utils/connectionConfigFields";

/**
 * A step of a graphical (VNC / RDP) connect (#5068, #5626): the SSH tunnel
 * (tunnelled sessions only), the protocol handshake, authentication, and the
 * first painted frame.
 */
export type GraphicalStep = "tunnel" | "connect" | "authenticate" | "firstFrame";

const LABELS: Record<GraphicalStep, string> = {
  tunnel: "SSH tunnel",
  connect: "Connect",
  authenticate: "Authenticate",
  firstFrame: "First frame",
};

/**
 * The stepper for a graphical connect with `at` reached: earlier steps are
 * done, `at` is active (or failed when `failed`), later ones pending. A
 * tunnelled session goes through the SSH tunnel first.
 */
export function graphicalStages(
  at: GraphicalStep,
  tunnelled: boolean,
  failed = false
): ConnectStage[] {
  const steps: GraphicalStep[] = tunnelled
    ? ["tunnel", "connect", "authenticate", "firstFrame"]
    : ["connect", "authenticate", "firstFrame"];
  // A direct session has no tunnel step: its connect starts at the handshake.
  const index = Math.max(0, steps.indexOf(at === "connect" && tunnelled ? "tunnel" : at));
  return steps.map((id, i) => ({
    id,
    label: LABELS[id],
    state: i < index ? "done" : i > index ? "pending" : failed ? "failed" : "active",
  }));
}

/**
 * The SSH gateway a graphical connection tunnels through, as `user@host` (or
 * just `host` without a username), or `null` for a direct connection (#5626).
 */
export function sshTunnelVia(config: ConnectionConfig | undefined | null): string | null {
  if (readConfigBoolean(config, "useSshTunnel") !== true) return null;
  const host = readConfigString(config, "sshHost")?.trim();
  if (!host) return null;
  const user = readConfigString(config, "sshUsername")?.trim();
  return user ? `${user}@${host}` : host;
}
