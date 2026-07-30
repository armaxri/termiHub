import { Select } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";
import {
  RunLocation,
  decodeRunLocation,
  encodeRunLocation,
  runLocationOptions,
} from "@/utils/runLocation";

/** Props for the shared {@link RunLocationSelect} control. */
export interface RunLocationSelectProps {
  /** The item's current run-location. */
  value: RunLocation;
  /** Agents offered as run targets ("This computer" is always offered). */
  agents: RemoteAgentDefinition[];
  /** Called with the newly chosen run-location. */
  onChange: (location: RunLocation) => void;
  /**
   * Whether an agent may host this item. `false` for a desktop-only item (Open
   * Design Decision #4) — the control then offers only "This computer".
   * Defaults to `true`.
   */
  agentAllowed?: boolean;
  /** Force-disable the control. */
  disabled?: boolean;
  /** Accessible label for the trigger. Defaults to "Run on". */
  "aria-label"?: string;
  /** Test hook forwarded to the trigger. */
  "data-testid"?: string;
}

/**
 * The shared "Run on" selector — a thin, token-styled wrapper over the `Select`
 * primitive that both the tunnel host control and the network-tool /
 * embedded-server run-location selectors compose from (#2191). It renders
 * "This computer" plus one option per agent, defaulting to the desktop; a
 * desktop-only item (`agentAllowed={false}`) offers only "This computer".
 *
 * The control has no state of its own — the caller owns the value and persists
 * the choice — so the selector stays a pure renderer over the run-location
 * model.
 */
export function RunLocationSelect({
  value,
  agents,
  onChange,
  agentAllowed = true,
  disabled,
  ...rest
}: RunLocationSelectProps) {
  const options = runLocationOptions(agents, agentAllowed);
  // With no agent to offer, "This computer" is the only choice — disable the
  // control so it reads as a fixed vantage rather than an interactive no-op.
  const singleChoice = options.length === 1;

  return (
    <Select
      value={encodeRunLocation(value)}
      onChange={(v) => onChange(decodeRunLocation(v))}
      options={options}
      disabled={disabled || singleChoice}
      aria-label={rest["aria-label"] ?? "Run on"}
      data-testid={rest["data-testid"]}
    />
  );
}
