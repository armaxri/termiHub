import { useId } from "react";
import { NumberInput, type NumberInputProps } from "@/components/ui";
import { joinIds, settingsNumberChars } from "./settingsNumber";
import { SettingsNumberFrame } from "./SettingsNumberFrame";

export interface SettingsNumberInputProps extends Omit<NumberInputProps, "data-testid"> {
  /** Unit shown after the input, e.g. "sessions" or "s" (#5843). */
  unit?: string;
  /** Test id of the input itself; the unit gets `<id>-unit`. */
  "data-testid"?: string;
}

/**
 * A numeric setting without a "follow the default" state, in the compact
 * settings layout (#5843): the shared {@link NumberInput}, sized to its value
 * range and followed by its unit, like {@link DefaultNumberInput}.
 */
export function SettingsNumberInput({
  unit,
  min,
  max,
  step,
  className,
  "aria-describedby": ariaDescribedBy,
  "data-testid": testId,
  ...rest
}: SettingsNumberInputProps) {
  const unitId = useId();
  const toNumber = (v: string | number | undefined) =>
    v === undefined || v === "" ? undefined : Number(v);
  return (
    <SettingsNumberFrame
      chars={settingsNumberChars(toNumber(min), toNumber(max), toNumber(step))}
      unit={unit}
      unitId={unitId}
      data-testid={testId}
    >
      <NumberInput
        {...rest}
        min={min}
        max={max}
        step={step}
        className={["settings-number__input", className ?? ""].filter(Boolean).join(" ")}
        aria-describedby={joinIds(ariaDescribedBy, unit ? unitId : undefined)}
        data-testid={testId}
      />
    </SettingsNumberFrame>
  );
}
