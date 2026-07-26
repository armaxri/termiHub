import { describe, it, expect } from "vitest";
import {
  PLUGIN_CONNECTION_TYPE_ICON,
  isPluginConnectionType,
  partitionConnectionTypes,
} from "./pluginConnectionTypes";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SettingsSchema, Capabilities } from "@/types/schema";

const EMPTY_SCHEMA: SettingsSchema = { groups: [] };
const CAPS: Capabilities = {
  monitoring: false,
  fileBrowser: false,
  resize: true,
  persistent: false,
  terminal: true,
};

function type(typeId: string, displayName: string, icon: string): ConnectionTypeInfo {
  return { typeId, displayName, icon, schema: EMPTY_SCHEMA, capabilities: CAPS };
}

describe("isPluginConnectionType", () => {
  it("is true only for the plugin (puzzle) icon", () => {
    expect(isPluginConnectionType(type("acme", "Acme", PLUGIN_CONNECTION_TYPE_ICON))).toBe(true);
    expect(isPluginConnectionType(type("ssh", "SSH", "ssh"))).toBe(false);
    expect(isPluginConnectionType(type("local", "Local", "terminal"))).toBe(false);
  });
});

describe("partitionConnectionTypes", () => {
  it("splits built-in and plugin-provided types, preserving order", () => {
    const registry = [
      type("local", "Local", "terminal"),
      type("ssh", "SSH", "ssh"),
      type("acme", "Acme Terminal", PLUGIN_CONNECTION_TYPE_ICON),
      type("serial", "Serial", "serial"),
      type("widget", "Widget Shell", PLUGIN_CONNECTION_TYPE_ICON),
    ];

    const { builtins, plugins } = partitionConnectionTypes(registry);

    expect(builtins.map((t) => t.typeId)).toEqual(["local", "ssh", "serial"]);
    expect(plugins.map((t) => t.typeId)).toEqual(["acme", "widget"]);
  });

  it("keeps two same-named plugin backends distinct via their disambiguated ids/labels", () => {
    // The backend suffixes colliding connectionType names before they reach the
    // registry (#1999), so partitioning surfaces both with distinct labels.
    const registry = [
      type("local", "Local", "terminal"),
      type("gopher-acme", "Gopher (Acme)", PLUGIN_CONNECTION_TYPE_ICON),
      type("gopher-globex", "Gopher (Globex)", PLUGIN_CONNECTION_TYPE_ICON),
    ];

    const { plugins } = partitionConnectionTypes(registry);

    expect(plugins.map((t) => t.typeId)).toEqual(["gopher-acme", "gopher-globex"]);
    expect(plugins.map((t) => t.displayName)).toEqual(["Gopher (Acme)", "Gopher (Globex)"]);
  });

  it("returns an empty plugin group when no plugin types are present", () => {
    const registry = [type("local", "Local", "terminal"), type("ssh", "SSH", "ssh")];
    const { builtins, plugins } = partitionConnectionTypes(registry);
    expect(plugins).toEqual([]);
    expect(builtins).toHaveLength(2);
  });
});
