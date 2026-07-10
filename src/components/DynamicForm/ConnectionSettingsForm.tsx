import { useCallback, useEffect, useMemo, useRef } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { SettingsSchema } from "@/types/schema";
import { isFieldVisible } from "@/utils/schemaDefaults";
import { parseHostPort } from "@/utils/parseHostPort";
import { settingsSchemaToZod } from "./settingsSchemaToZod";
import { DynamicField } from "./DynamicField";

interface ConnectionSettingsFormProps {
  schema: SettingsSchema;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  /**
   * When true, a "Password saved in credential store" hint is shown below
   * password fields that are currently empty (i.e. the credential is stored
   * and will not be overwritten unless the user types a new value).
   */
  credentialSavedHint?: boolean;
  /**
   * Pre-supplied serial port names for `serialPort` fields.
   * Pass the remote agent's `availableSerialPorts` here when editing an
   * agent definition so the dropdown reflects the remote machine's ports.
   */
  availablePorts?: string[];
  /**
   * Reports overall client-side validity plus a per-field error map (keyed by
   * field key) whenever validation state changes. Only currently-visible fields
   * are considered, so a required field hidden by `visibleWhen` never blocks.
   * The parent uses this to disable Save/Save & Connect on invalid input.
   */
  onValidityChange?: (valid: boolean, errors: Record<string, string>) => void;
}

/**
 * Generic connection settings form renderer backed by react-hook-form and zod.
 *
 * Manages field state, dirty tracking, and client-side validation internally.
 * Changes are propagated to the parent via `onChange` on every field update.
 * Backend validation in Agent.connect remains authoritative; zod is UX only.
 */
export function ConnectionSettingsForm({
  schema,
  settings,
  onChange,
  credentialSavedHint,
  availablePorts,
  onValidityChange,
}: ConnectionSettingsFormProps) {
  const zodSchema = useMemo(() => settingsSchemaToZod(schema), [schema]);

  const { control, watch, reset, setValue } = useForm<Record<string, unknown>>({
    defaultValues: settings,
    resolver: zodResolver(zodSchema),
    mode: "onChange",
  });

  // Whether this schema has a sibling `port` field — gates the host:port split.
  const hasPortField = useMemo(
    () => schema.groups.some((g) => g.fields.some((f) => f.key === "port")),
    [schema]
  );

  // Auto-extract `host:port` typed into the Host field on blur (PR #195 / #895).
  // `192.168.0.2:2222` → host `192.168.0.2` + port `2222`; `[::1]:22` → IPv6
  // host + port; a bare host or bare IPv6 is left untouched.
  const handleFieldBlur = useCallback(
    (fieldKey: string, value: unknown) => {
      if (fieldKey !== "host" || !hasPortField) return;
      if (typeof value !== "string") return;
      const { host, port } = parseHostPort(value);
      if (port === null) return;
      setValue("host", host, { shouldValidate: true, shouldDirty: true });
      setValue("port", port, { shouldValidate: true, shouldDirty: true });
    },
    [hasPortField, setValue]
  );

  // Reset the form when the connection type changes (schema groups differ).
  // isResetting suppresses the watch callback that reset fires synchronously,
  // preventing a spurious onChange call back to the parent on type switch.
  const schemaKey = schema.groups.map((g) => g.key).join("|");
  const prevSchemaKey = useRef(schemaKey);
  const isResetting = useRef(false);
  useEffect(() => {
    if (prevSchemaKey.current !== schemaKey) {
      prevSchemaKey.current = schemaKey;
      isResetting.current = true;
      reset(settings);
    }
    // Only trigger on schema change, not on every settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // Propagate every form value change to the parent.
  useEffect(() => {
    const subscription = watch((values) => {
      if (isResetting.current) {
        isResetting.current = false;
        return;
      }
      onChange(values as Record<string, unknown>);
    });
    return () => subscription.unsubscribe();
  }, [watch, onChange]);

  // Live form values used for visibleWhen evaluation.
  const watchedValues = useWatch({ control });

  // Overall validity + per-field error map for currently-visible fields. We run
  // the zod schema directly against the watched values (rather than reading
  // react-hook-form's async error proxy) so the signal is deterministic and
  // recomputes on every value change. A required field hidden by `visibleWhen`
  // is excluded, so it never blocks the parent's Save.
  const validity = useMemo(() => {
    const errorMap: Record<string, string> = {};
    const result = zodSchema.safeParse(watchedValues);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !(key in errorMap)) {
          errorMap[key] = issue.message;
        }
      }
    }
    const visibleErrors: Record<string, string> = {};
    for (const group of schema.groups) {
      for (const field of group.fields) {
        if (isFieldVisible(field, watchedValues) && errorMap[field.key]) {
          visibleErrors[field.key] = errorMap[field.key];
        }
      }
    }
    return { valid: Object.keys(visibleErrors).length === 0, errors: visibleErrors };
  }, [zodSchema, watchedValues, schema]);

  useEffect(() => {
    onValidityChange?.(validity.valid, validity.errors);
  }, [validity, onValidityChange]);

  return (
    <div data-testid="connection-settings-form">
      {schema.groups.map((group) => {
        const visibleFields = group.fields.filter((f) => isFieldVisible(f, watchedValues));
        if (visibleFields.length === 0) return null;
        return (
          <div
            className="settings-panel__category"
            key={group.key}
            data-testid={`form-group-${group.key}`}
          >
            <h3 className="settings-panel__category-title">{group.label}</h3>
            {visibleFields.map((field) => (
              <Controller
                key={field.key}
                name={field.key}
                control={control}
                render={({ field: rhfField, fieldState }) => (
                  <DynamicField
                    field={field}
                    value={rhfField.value}
                    onChange={rhfField.onChange}
                    onBlur={() => handleFieldBlur(field.key, rhfField.value)}
                    error={fieldState.error?.message}
                    credentialSaved={
                      credentialSavedHint && field.fieldType.type === "password" && !rhfField.value
                    }
                    availablePorts={availablePorts}
                  />
                )}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
