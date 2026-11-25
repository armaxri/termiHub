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
import type { HostChoice } from "@/utils/hostChoice";
import { isAgentHost } from "@/utils/tunnelHost";

export { THIS_COMPUTER, isAgentHost };
export type { RunLocation };

/** `Select` value for the "This computer" (desktop) option. */
export const RUN_LOCATION_THIS = "this";

/** Prefix for an agent option's `Select` value (`agent:<id>`). */
const AGENT_PREFIX = "agent:";

/** `Select` value of a host this build cannot read (#6028). */
const UNREADABLE = "unreadable";

/** Encode a run-location as a `Select` option value. */
export function encodeRunLocation(location: HostChoice): string {
  if (location.kind === "unreadable") return UNREADABLE;
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
 *
 * `current` is the item's stored machine. When it cannot be offered (an agent
 * that was removed, a host this build cannot read) it is added as a disabled
 * option, so the control shows what is stored instead of nothing, and a save
 * that does not touch it does not change it (#6028).
 */
export function runLocationOptions(
  agents: RemoteAgentDefinition[],
  agentAllowed: boolean,
  current?: HostChoice
): SelectOption[] {
  const options: SelectOption[] = [{ value: RUN_LOCATION_THIS, label: "This computer" }];
  if (agentAllowed) {
    for (const agent of agents) {
      options.push({ value: `${AGENT_PREFIX}${agent.id}`, label: `Agent · ${agent.name}` });
    }
  }
  const value = current && encodeRunLocation(current);
  if (current && value && !options.some((o) => o.value === value)) {
    const label = current.kind === "unreadable" ? "Unknown machine" : "Removed agent";
    options.push({ value, label, disabled: true });
  }
  return options;
}
