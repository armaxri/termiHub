/**
 * Adapters that turn a plugin manifest's `settings` block
 * (`Record<string, PluginSettingSchema>`) into the shapes the generic
 * `DynamicForm` machinery consumes: a {@link SettingsSchema} for rendering and a
 * flat defaults object for seeding unset values.
 *
 * A plugin's `settings` schema is intentionally simpler than a connection's
 * `configSchema` — each entry is a single primitive (`string`/`number`/
 * `boolean`) with an optional `enum`, no grouping or conditional visibility — so
 * every plugin's settings collapse into one `DynamicForm` group.
 */
import type { FieldType, SettingsField, SettingsSchema } from "@/types/schema";
import type { JsonValue, PluginSettingSchema } from "@/types/plugin";

/**
 * Turn a setting key into a human-readable label: split camelCase and
 * snake/kebab boundaries into words and title-case the result
 * (`maxLineLength` / `max_line_length` → "Max Line Length").
 */
export function humanizeSettingKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map a single plugin setting schema to a {@link DynamicForm} field type. */
function fieldTypeForSetting(schema: PluginSettingSchema): FieldType {
  if (schema.enum && schema.enum.length > 0) {
    return { type: "select", options: schema.enum.map((v) => ({ value: v, label: v })) };
  }
  switch (schema.type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "string":
    default:
      return { type: "text" };
  }
}

/**
 * Build a single-group {@link SettingsSchema} from a plugin's declared settings,
 * preserving declaration order. `groupKey`/`groupLabel` name the sole group the
 * `DynamicForm` renders (the section supplies the plugin's own header, so an
 * empty label is fine).
 */
export function pluginSettingsToSchema(
  settings: Record<string, PluginSettingSchema>,
  groupKey: string,
  groupLabel = ""
): SettingsSchema {
  const fields: SettingsField[] = Object.entries(settings).map(([key, schema]) => ({
    key,
    label: humanizeSettingKey(key),
    description: schema.description || undefined,
    fieldType: fieldTypeForSetting(schema),
    required: false,
    default: schema.default,
  }));
  return { groups: [{ key: groupKey, label: groupLabel, fields }] };
}

/**
 * Collect the `default` value of every declared setting into a flat object,
 * used to seed the form before the persisted values (if any) are layered on top.
 */
export function pluginSettingsDefaults(
  settings: Record<string, PluginSettingSchema>
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, schema] of Object.entries(settings)) {
    out[key] = schema.default;
  }
  return out;
}
