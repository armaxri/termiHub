import { cloneElement, useId } from "react";
import type { ReactElement, ReactNode } from "react";
import { AlertCircle } from "lucide-react";

/** Visual variant applied to the field's hint text. */
export type SettingsHintVariant = "default" | "warning";

/** Accessibility props {@link SettingsField} injects onto its single control child. */
interface InjectedControlProps {
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}

export interface SettingsFieldProps {
  /**
   * The visible field label. Also derives the control's `aria-label` so the
   * label text is stated once per field instead of being repeated as a manual
   * `aria-label` at each call site.
   */
  label: string;
  /** Optional explanatory hint rendered below the control. */
  hint?: ReactNode;
  /** Hint styling — `"warning"` colors the hint as a caution. Defaults to `"default"`. */
  hintVariant?: SettingsHintVariant;
  /**
   * Optional resolved validation message. When set, an inline error is rendered
   * below the control using the same affordance (icon + `ui-field__msg` markup)
   * as the shared {@link Field} primitive, and the control is marked
   * `aria-invalid` and linked to the message via `aria-describedby` — so the two
   * field wrappers surface validation consistently. Absent by default: callers
   * that pass no `error` render exactly as before.
   */
  error?: ReactNode;
  /**
   * The single control the field wraps (a `Toggle`, `Select`, `input`, etc.).
   * Its `aria-label` is set from {@link SettingsFieldProps.label} unless the
   * control already declares its own.
   */
  children: ReactElement<InjectedControlProps>;
}

/**
 * Merge an existing `aria-describedby` (which the child may already carry) with
 * the error-message id, de-duplicating and dropping empties. Returns `undefined`
 * when there is nothing to describe so the attribute is omitted entirely.
 */
function mergeDescribedBy(existing: unknown, extra?: string): string | undefined {
  const ids = new Set<string>();
  if (typeof existing === "string") {
    for (const id of existing.split(/\s+/)) if (id) ids.add(id);
  }
  if (extra) ids.add(extra);
  return ids.size > 0 ? Array.from(ids).join(" ") : undefined;
}

/**
 * Shared wrapper for a Settings panel field: renders the `settings-form__field`
 * label/control/hint scaffold once and wires the control's accessible name from
 * the label, collapsing the field markup that every Settings panel used to
 * hand-repeat. When an `error` is supplied it also renders an inline validation
 * message matching the shared {@link Field} primitive.
 */
export function SettingsField({
  label,
  hint,
  hintVariant = "default",
  error,
  children,
}: SettingsFieldProps): ReactElement {
  const errorId = useId();
  const hasError = error !== undefined && error !== null && error !== false;
  const childProps = children.props;

  // Only clone when we actually change a prop, so callers that already set an
  // aria-label and pass no error keep their element untouched.
  const injected: InjectedControlProps = {};
  if (childProps["aria-label"] === undefined) {
    injected["aria-label"] = label;
  }
  if (hasError) {
    injected["aria-invalid"] = true;
    injected["aria-describedby"] = mergeDescribedBy(childProps["aria-describedby"], errorId);
  }
  const control = Object.keys(injected).length > 0 ? cloneElement(children, injected) : children;

  const hintClassName =
    hintVariant === "warning"
      ? "settings-form__hint settings-form__hint--warning"
      : "settings-form__hint";

  return (
    <div className="settings-form__field">
      <span className="settings-form__label">{label}</span>
      {control}
      {hint !== undefined && hint !== null && <span className={hintClassName}>{hint}</span>}
      {hasError && (
        <span
          className="ui-field__msg"
          id={errorId}
          role="alert"
          data-testid="settings-field-error"
        >
          <AlertCircle className="ui-field__msg-icon" aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}
