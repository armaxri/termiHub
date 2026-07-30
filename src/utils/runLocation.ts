/**
 * Shared "Run on" (run-location) helpers — the view-model layer behind the
 * per-item run-location selector (#2191).
 *
 * A {@link RunLocation} says which machine an item (tunnel, network tool, or
 * embedded server) executes on: this computer (the desktop) or a named agent.
 * The type and its `THIS_COMPUTER` constant are defined once in `@/types/tunnel`
 * (the first subsystem to grow a run-location) and re-exported here so the
 * network-tool and embedded-server call sites need not import from a
 * tunnel-named module. These helpers turn a {@link RunLocation} into the
 * `Select` option list / encoded value both the tunnel host control and the new
 * selector share, so there is one encoding, not three.
 */

import type { SelectOption } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";
import { RunLocation, THIS_COMPUTER } from "@/types/tunnel";
import { isAgentHost } from "@/utils/tunnelHost";

export { THIS_COMPUTER, isAgentHost };
export type { RunLocation };

/** `Select` value for the "This computer" (desktop) option. */
export const RUN_LOCATION_THIS = "this";

/** Prefix for an agent option's `Select` value (`agent:<id>`). */
const AGENT_PREFIX = "agent:";

/** Encode a run-location as a `Select` option value. */
export function encodeRunLocation(location: RunLocation): string {
  return isAgentHost(location) ? `${AGENT_PREFIX}${location.agentId}` : RUN_LOCATION_THIS;
}

/** Decode a `Select` option value back into a run-location. */
export function decodeRunLocation(value: string): RunLocation {
  return value.startsWith(AGENT_PREFIX)
    ? { kind: "agent", agentId: value.slice(AGENT_PREFIX.length) }
    : THIS_COMPUTER;
}

/**
 * The "Run on" option list: "This computer" first, then one option per agent.
 *
 * When `agentAllowed` is `false` — a desktop-only item, per Open Design
 * Decision #4 — only "This computer" is offered, so the agent option can never
 * be picked for an item the agent cannot host.
 */
export function runLocationOptions(
  agents: RemoteAgentDefinition[],
  agentAllowed: boolean
): SelectOption[] {
  const options: SelectOption[] = [{ value: RUN_LOCATION_THIS, label: "This computer" }];
  if (agentAllowed) {
    for (const agent of agents) {
      options.push({ value: `${AGENT_PREFIX}${agent.id}`, label: `Agent · ${agent.name}` });
    }
  }
  return options;
}

/**
 * The human label for a run-location, naming the agent when it is known —
 * "This computer" or "Agent · «name»" — for a badge / where-it-runs indicator.
 */
export function runLocationLabel(location: RunLocation, agents: RemoteAgentDefinition[]): string {
  if (!isAgentHost(location)) return "This computer";
  const name = agents.find((a) => a.id === location.agentId)?.name ?? location.agentId;
  return `Agent · ${name}`;
}
