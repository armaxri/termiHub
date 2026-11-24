import { forwardRef } from "react";
import { NumberInput, type InputProps } from "@/components/ui";

/** Props of {@link SecondsInput}. */
export interface SecondsInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  /** The stored value in milliseconds; `undefined` shows an empty field. */
  valueMs: number | undefined;
  /** Called with whole milliseconds, or `undefined` when the field is cleared. */
  onChangeMs: (valueMs: number | undefined) => void;
}

/**
 * A duration edited in seconds (R-167: "users think in seconds") and stored in
 * milliseconds. Milliseconds stay whole, as the backend requires. A negative
 * value is kept for validation to name.
 */
export const SecondsInput = forwardRef<HTMLInputElement, SecondsInputProps>(function SecondsInput(
  { valueMs, onChangeMs, ...rest },
  ref
) {
  return (
    <NumberInput
      ref={ref}
      min={0}
      step={0.1}
      {...rest}
      value={valueMs === undefined ? "" : valueMs / 1000}
      onValueChange={(v) => onChangeMs(v === "" ? undefined : Math.round(v * 1000))}
    />
  );
});
