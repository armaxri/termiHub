import { useCallback } from "react";
import type { SettingsSchema } from "@/types/schema";
import { isFieldVisible } from "@/utils/schemaDefaults";
import { DynamicField } from "./DynamicField";

interface ConnectionSettingsFormProps {
  schema: SettingsSchema;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}

/**
 * Generic connection settings form renderer.
 *
 * Iterates groups and fields from the schema, evaluates visibility
 * conditions, and delegates each field to DynamicField.
 */
export function ConnectionSettingsForm({
  schema,
  settings,
  onChange,
}: ConnectionSettingsFormProps) {
  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...settings, [key]: value });
    },
    [settings, onChange]
  );

  return (
    <div className="settings-form" data-testid="connection-settings-form">
      {schema.groups.map((group) => {
        const visibleFields = group.fields.filter((f) => isFieldVisible(f, settings));
        if (visibleFields.length === 0) return null;
        return (
          <div key={group.key} data-testid={`form-group-${group.key}`}>
            {visibleFields.map((field) => (
              <DynamicField
                key={field.key}
                field={field}
                value={settings[field.key]}
                onChange={handleFieldChange}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
