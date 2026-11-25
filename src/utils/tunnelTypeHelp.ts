/**
 * What the three SSH tunnel types mean, in plain words (#6027) — the one source
 * for every surface that names a tunnel type: the editor's type cards, the
 * sidebar row's tooltip and the connection editor's Port Forwarding section.
 *
 * The wording follows the SSH semantics the editor's endpoint lines show
 * (`tunnelHost.ts`): "local" is the machine that hosts the tunnel, so a local
 * or dynamic tunnel listens there and its target is reached from the SSH
 * server; a remote tunnel listens on the SSH server and its target is reached
 * from the hosting machine.
 */
import { t, tf } from "@/i18n/catalog";
import type { RunLocation, TunnelType } from "@/types/tunnel";
import { THIS_COMPUTER } from "@/types/tunnel";
import { isAgentHost, tunnelHostMachine } from "@/utils/tunnelHost";

/** `"local"`, `"remote"` or `"dynamic"`. */
export type TunnelTypeKind = TunnelType["type"];

/** The tunnel types in the order every surface lists them. */
export const TUNNEL_TYPE_KINDS: readonly TunnelTypeKind[] = ["local", "remote", "dynamic"];

/** The explanation of one tunnel type. */
export interface TunnelTypeHelp {
  /** `Local`, `Remote` or `Dynamic`. */
  label: string;
  /** The matching `ssh` flag: `ssh -L`, `ssh -R` or `ssh -D`. */
  flag: string;
  /** A short phrase for a card or a list line; no full stop. */
  summary: string;
  /** What it is for, how it works, an everyday example: one sentence or two each. */
  lines: readonly [lead: string, how: string, example: string];
}

const FLAGS: Record<TunnelTypeKind, string> = {
  local: "ssh -L",
  remote: "ssh -R",
  dynamic: "ssh -D",
};

/** The type's name: `Local`, `Remote` or `Dynamic`. */
export function tunnelTypeLabel(kind: TunnelTypeKind): string {
  switch (kind) {
    case "local":
      return t("tunnel.type.local.label");
    case "remote":
      return t("tunnel.type.remote.label");
    case "dynamic":
      return t("tunnel.type.dynamic.label");
  }
}

/**
 * Explain `kind` for a tunnel hosted on `host`. `agentName` is the resolved
 * name of an agent host, falling back to its raw id.
 */
export function tunnelTypeHelp(
  kind: TunnelTypeKind,
  host: RunLocation = THIS_COMPUTER,
  agentName?: string
): TunnelTypeHelp {
  const onAgent = isAgentHost(host);
  const params = { machine: tunnelHostMachine(host, agentName) };
  const base = { label: tunnelTypeLabel(kind), flag: FLAGS[kind] };
  switch (kind) {
    case "local":
      return {
        ...base,
        summary: t("tunnel.type.local.summary"),
        lines: [
          tf(onAgent ? "tunnel.type.local.lead.agent" : "tunnel.type.local.lead", params),
          tf("tunnel.type.local.how", params),
          tf("tunnel.type.local.example", params),
        ],
      };
    case "remote":
      return {
        ...base,
        summary: t(onAgent ? "tunnel.type.remote.summary.agent" : "tunnel.type.remote.summary"),
        lines: [
          tf(onAgent ? "tunnel.type.remote.lead.agent" : "tunnel.type.remote.lead", params),
          tf("tunnel.type.remote.how", params),
          tf("tunnel.type.remote.example", params),
        ],
      };
    case "dynamic":
      return {
        ...base,
        summary: t("tunnel.type.dynamic.summary"),
        lines: [
          t("tunnel.type.dynamic.lead"),
          tf("tunnel.type.dynamic.how", params),
          tf(onAgent ? "tunnel.type.dynamic.example.agent" : "tunnel.type.dynamic.example", params),
        ],
      };
  }
}
