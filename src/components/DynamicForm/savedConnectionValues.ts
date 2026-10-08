import type { SavedConnection } from "@/types/connection";
import type { SettingsSchema } from "@/types/schema";

/**
 * The values a form derives from its `savedConnection` fields (#4194), for
 * visibility conditions and notice placeholders: for a field `key` whose value
 * names exactly one saved connection of the field's type, `<key>.host` (that
 * connection's `host` setting) and `<key>.name`. A field that names no
 * connection — none chosen, a deleted one, or an id several connection files
 * hold — derives nothing, so a condition comparing with it sees an unset side.
 */
export function savedConnectionValues(
  schema: SettingsSchema,
  values: Record<string, unknown> | undefined,
  connections: readonly SavedConnection[]
): Record<string, string> {
  const derived: Record<string, string> = {};
  for (const group of schema.groups) {
    for (const field of group.fields) {
      const fieldType = field.fieldType;
      if (fieldType.type !== "savedConnection") continue;
      const id = values?.[field.key];
      if (typeof id !== "string" || id === "") continue;
      const matches = connections.filter(
        (c) => c.id === id && c.config.type === fieldType.connectionType
      );
      if (matches.length !== 1) continue;
      const host = matches[0].config.config.host;
      if (typeof host === "string") derived[`${field.key}.host`] = host;
      derived[`${field.key}.name`] = matches[0].name;
    }
  }
  return derived;
}
