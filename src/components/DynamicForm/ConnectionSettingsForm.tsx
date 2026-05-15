import { useEffect, useMemo, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { SettingsSchema } from "@/types/schema";
import { isFieldVisible } from "@/utils/schemaDefaults";
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
}: ConnectionSettingsFormProps) {
  const zodSchema = useMemo(() => settingsSchemaToZod(schema), [schema]);

  const { control, watch, reset } = useForm<Record<string, unknown>>({
    defaultValues: settings,
    resolver: zodResolver(zodSchema),
    mode: "onChange",
  });

  // Reset the form when the connection type changes (schema groups differ).
  const schemaKey = schema.groups.map((g) => g.key).join("|");
  const prevSchemaKey = useRef(schemaKey);
  useEffect(() => {
    if (prevSchemaKey.current !== schemaKey) {
      prevSchemaKey.current = schemaKey;
      reset(settings);
    }
    // Only trigger on schema change, not on every settings update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  // Propagate every form value change to the parent.
  useEffect(() => {
    const subscription = watch((values) => {
      onChange(values as Record<string, unknown>);
    });
    return () => subscription.unsubscribe();
  }, [watch, onChange]);

  // Live form values used for visibleWhen evaluation.
  const watchedValues = watch();

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
