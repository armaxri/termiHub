import { useCallback } from "react";
import type { SettingsSchema } from "@/types/schema";
import { isFieldVisible } from "@/utils/schemaDefaults";
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
  credentialSavedHint,
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
                credentialSaved={
                  credentialSavedHint && field.fieldType.type === "password" && !settings[field.key]
                }
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
