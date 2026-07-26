/**
 * Tests for the plugin-manifest → DynamicForm adapters (#2000): key humanizing,
 * primitive/enum → field-type mapping, single-group schema construction, and the
 * defaults collector.
 */
import { describe, it, expect } from "vitest";
import type { PluginSettingSchema } from "@/types/plugin";
import {
  humanizeSettingKey,
  pluginSettingsDefaults,
  pluginSettingsToSchema,
} from "./pluginSettingsSchema";

describe("humanizeSettingKey", () => {
  it("splits camelCase into title-cased words", () => {
    expect(humanizeSettingKey("maxLineLength")).toBe("Max Line Length");
  });

  it("splits snake_case and kebab-case", () => {
    expect(humanizeSettingKey("max_line_length")).toBe("Max Line Length");
    expect(humanizeSettingKey("color-scheme")).toBe("Color Scheme");
  });

  it("title-cases a single lowercase word", () => {
    expect(humanizeSettingKey("namespace")).toBe("Namespace");
  });
});

describe("pluginSettingsToSchema", () => {
  const settings: Record<string, PluginSettingSchema> = {
    namespace: { type: "string", default: "default", description: "Target namespace" },
    maxLines: { type: "number", default: 500, description: "Lines to keep" },
    verbose: { type: "boolean", default: false, description: "Verbose logging" },
    level: {
      type: "string",
      default: "info",
      description: "Log level",
      enum: ["debug", "info", "warn"],
    },
  };

  it("produces a single group keyed by the plugin id, preserving order", () => {
    const schema = pluginSettingsToSchema(settings, "log-colorizer");
    expect(schema.groups).toHaveLength(1);
    expect(schema.groups[0].key).toBe("log-colorizer");
    expect(schema.groups[0].fields.map((f) => f.key)).toEqual([
      "namespace",
      "maxLines",
      "verbose",
      "level",
    ]);
  });

  it("maps primitives to the right field types and enums to a select", () => {
    const [ns, max, verbose, level] = pluginSettingsToSchema(settings, "p").groups[0].fields;
    expect(ns.fieldType).toEqual({ type: "text" });
    expect(max.fieldType).toEqual({ type: "number" });
    expect(verbose.fieldType).toEqual({ type: "boolean" });
    expect(level.fieldType).toEqual({
      type: "select",
      options: [
        { value: "debug", label: "debug" },
        { value: "info", label: "info" },
        { value: "warn", label: "warn" },
      ],
    });
  });

  it("carries description and default, and marks fields optional", () => {
    const ns = pluginSettingsToSchema(settings, "p").groups[0].fields[0];
    expect(ns.label).toBe("Namespace");
    expect(ns.description).toBe("Target namespace");
    expect(ns.default).toBe("default");
    expect(ns.required).toBe(false);
  });
});

describe("pluginSettingsDefaults", () => {
  it("collects each setting's default into a flat object", () => {
    const settings: Record<string, PluginSettingSchema> = {
      a: { type: "string", default: "x", description: "" },
      b: { type: "number", default: 7, description: "" },
    };
    expect(pluginSettingsDefaults(settings)).toEqual({ a: "x", b: 7 });
  });

  it("returns an empty object for no settings", () => {
    expect(pluginSettingsDefaults({})).toEqual({});
  });
});
