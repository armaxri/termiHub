import { z } from "zod";
import type { SettingsField, SettingsSchema } from "@/types/schema";

/**
 * Convert a SettingsSchema into a zod object schema for client-side validation.
 *
 * Maps each field type to its corresponding zod validator with appropriate
 * bounds. Backend validation in Agent.connect remains authoritative; this
 * schema is for UX feedback only.
 */
export function settingsSchemaToZod(schema: SettingsSchema) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const group of schema.groups) {
    for (const field of group.fields) {
      shape[field.key] = fieldToZod(field);
    }
  }
  return z.object(shape);
}

function fieldToZod(field: SettingsField): z.ZodTypeAny {
  const ft = field.fieldType;

  switch (ft.type) {
    case "port": {
      const portSchema = z
        .number()
        .int("Must be an integer")
        .min(1, "Port must be between 1 and 65535")
        .max(65535, "Port must be between 1 and 65535");
      return field.required ? portSchema : portSchema.optional();
    }

    case "number": {
      let num = z.number();
      if (ft.min !== undefined) num = num.min(ft.min, `Must be at least ${ft.min}`);
      if (ft.max !== undefined) num = num.max(ft.max, `Must be at most ${ft.max}`);
      return field.required ? num : num.optional();
    }

    case "boolean":
      return z.boolean().optional();

    case "select":
      return z.string();

    case "text":
    case "password":
    case "filePath":
    case "serialPort":
      return field.required
        ? z.string().min(1, `${field.label} is required`)
        : z.string().optional();

    case "keyValueList":
      return z.array(z.object({ key: z.string(), value: z.string() })).optional();

    case "objectList":
      return z.array(z.record(z.string(), z.unknown())).optional();

    default:
      return z.unknown();
  }
}
