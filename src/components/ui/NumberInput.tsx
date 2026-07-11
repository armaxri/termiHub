import { forwardRef } from "react";
import { Input, type InputProps } from "./Input";

/**
 * Props for the shared {@link NumberInput} primitive. Mirrors {@link InputProps}
 * but swaps the raw string `value`/`onChange` for a `number | ""` value and a
 * typed change callback; `type` is fixed to `"number"`.
 */
export interface NumberInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  /** Current value; `""` represents an empty input. */
  value: number | "";
  /** Called with the parsed number, or `""` when the field is cleared. */
  onValueChange: (value: number | "") => void;
}

/**
 * The numeric sibling of {@link Input}: a shared `type="number"` control that
 * holds its value as `number | ""` and hides the string round-trip so call sites
 * never touch `e.target.value`. A cleared field stays `""` — so it reads blank
 * and can be flagged "required" — instead of being coerced to `0`. Compose it
 * inside a {@link Field} to get a label and inline validation message.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onValueChange, ...rest },
  ref
) {
  return (
    <Input
      ref={ref}
      type="number"
      value={value}
      onChange={(e) => onValueChange(e.target.value === "" ? "" : Number(e.target.value))}
      {...rest}
    />
  );
});
