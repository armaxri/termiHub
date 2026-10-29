import { useMemo, useRef, useState } from "react";
import type { SettingsField } from "@/types/schema";
import { Input } from "@/components/ui";
import { listAgentSerialPorts } from "@/services/api";
import { sortSerialPorts } from "@/utils/serialPorts";
import { useSerialPortRescan } from "./useSerialPortRescan";

interface SerialPortFieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Ports supplied externally (a remote agent's snapshot); skips the local scan. */
  availablePorts?: string[];
  /**
   * Rescan this connected agent's ports instead of using `availablePorts` as
   * given (#5069) — set only for an agent advertising `serialPortRescan`.
   * `availablePorts` (its connect-time snapshot) is shown until the first
   * agent scan answers, and kept if the agent turns out not to support it.
   */
  agentId?: string;
  /** The control's `id`, `aria-describedby` and invalid state from DynamicField. */
  a11y: { id: string; describedBy?: string; invalid: boolean };
  testIdBase: string;
}

const NO_PORTS: string[] = [];

/** Raised by the agent lister when the agent cannot list its ports on demand. */
class AgentRescanUnsupported extends Error {}

/**
 * Editable combobox for a `serialPort` field: detected ports in natural order,
 * rescanned while visible (#5066) — on the agent's host for an agent-hosted
 * connection (#5069) — with "(new)" / "(not connected)" hints.
 */
export function SerialPortField({
  field,
  value,
  onChange,
  availablePorts: propPorts,
  agentId,
  a11y,
  testIdBase,
}: SerialPortFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // An agent-hosted field never scans the local machine: no snapshot = none.
  const externalPorts = propPorts ?? (agentId !== undefined ? NO_PORTS : undefined);
  // The agent id whose agent answered "not supported": it keeps its snapshot.
  const [unsupportedAgent, setUnsupportedAgent] = useState<string | null>(null);
  const agentRescan = agentId !== undefined && unsupportedAgent !== agentId;
  const agentLister = useMemo(
    () =>
      agentId === undefined
        ? undefined
        : async () => {
            const result = await listAgentSerialPorts(agentId);
            if (!result.supported) {
              setUnsupportedAgent(agentId);
              throw new AgentRescanUnsupported(agentId);
            }
            return result.ports;
          },
    [agentId]
  );
  // Ports are re-enumerated while the field is on screen so plug/unplug shows
  // up within ~2 s: locally (#5066) or on the agent's host (#5069). Without
  // agent rescan support, an agent-supplied list is used as given.
  const detected = useSerialPortRescan({
    enabled: externalPorts === undefined || agentRescan,
    lister: agentRescan ? agentLister : undefined,
    targetRef: inputRef,
  });
  const suppliedPorts = useMemo(
    () => (externalPorts === undefined ? undefined : sortSerialPorts(externalPorts)),
    [externalPorts]
  );
  // An agent's snapshot stands in until its first scan succeeds.
  const showDetected = suppliedPorts === undefined || (agentRescan && detected.scanned);
  const availablePorts = showDetected ? detected.ports : (suppliedPorts ?? detected.ports);
  const loaded = showDetected ? detected.loaded : true;
  const newPorts = showDetected ? [...detected.newPorts] : [];
  const currentValue = (value as string) ?? "";
  // The selection is never changed by a rescan: an unplugged selected port
  // stays selected and is flagged instead.
  const isDisconnected = loaded && currentValue !== "" && !availablePorts.includes(currentValue);
  // An editable combobox (input + datalist) rather than a plain <select>: the
  // detected ports are offered as suggestions, but the user can still type any
  // device path the OS doesn't enumerate (a virtual/socat PTY, an uncommon
  // /dev path) — matching the field's "or type a device path directly" intent.
  const listId = `${testIdBase}-list`;

  return (
    <>
      <Input
        ref={inputRef}
        id={a11y.id}
        type="text"
        value={currentValue}
        onChange={(e) => onChange(e.target.value || undefined)}
        placeholder={field.placeholder}
        list={listId}
        autoComplete="off"
        spellCheck={false}
        aria-required={field.required || undefined}
        aria-describedby={a11y.describedBy}
        error={a11y.invalid}
        data-testid={testIdBase}
      />
      <datalist id={listId}>
        {availablePorts.map((port) => (
          <option
            key={port}
            value={port}
            label={showDetected && detected.newPorts.has(port) ? `${port} (new)` : undefined}
          />
        ))}
      </datalist>
      {isDisconnected && (
        <p className="settings-form__hint" data-testid={`${testIdBase}-disconnected`}>
          {currentValue} (not connected)
        </p>
      )}
      {newPorts.length > 0 && (
        <p className="settings-form__hint" role="status" data-testid={`${testIdBase}-new`}>
          Newly detected: {newPorts.join(", ")}
        </p>
      )}
    </>
  );
}
