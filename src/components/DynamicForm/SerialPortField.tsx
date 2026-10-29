import { useMemo, useRef } from "react";
import type { SettingsField } from "@/types/schema";
import { Input } from "@/components/ui";
import { sortSerialPorts } from "@/utils/serialPorts";
import { useSerialPortRescan } from "./useSerialPortRescan";

interface SerialPortFieldProps {
  field: SettingsField;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Ports supplied externally (a remote agent's snapshot); skips the local scan. */
  availablePorts?: string[];
  /** The control's `id`, `aria-describedby` and invalid state from DynamicField. */
  a11y: { id: string; describedBy?: string; invalid: boolean };
  testIdBase: string;
}

/**
 * Editable combobox for a `serialPort` field: detected ports in natural order,
 * rescanned while visible (#5066), with "(new)" / "(not connected)" hints.
 */
export function SerialPortField({
  field,
  value,
  onChange,
  availablePorts: propPorts,
  a11y,
  testIdBase,
}: SerialPortFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Local ports are re-enumerated while the field is on screen so plug/unplug
  // shows up within ~2 s (#5066); an agent-supplied list is used as given.
  const detected = useSerialPortRescan({ enabled: propPorts === undefined, targetRef: inputRef });
  const suppliedPorts = useMemo(
    () => (propPorts === undefined ? undefined : sortSerialPorts(propPorts)),
    [propPorts]
  );
  const availablePorts = suppliedPorts ?? detected.ports;
  const loaded = suppliedPorts !== undefined || detected.loaded;
  const newPorts = suppliedPorts !== undefined ? [] : [...detected.newPorts];
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
            label={detected.newPorts.has(port) ? `${port} (new)` : undefined}
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
