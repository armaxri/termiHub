import { describe, it, expect } from "vitest";
import {
  PLUGIN_CONNECTION_TYPE_ICON,
  isPluginConnectionType,
  partitionConnectionTypes,
  pluginConnectionTypeId,
  parsePluginConnectionTypeId,
  pluginConnectionIssue,
} from "./pluginConnectionTypes";
import type { PluginState } from "@/types/plugin";
import { backendPlugin } from "@/test/pluginFixtures";
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

describe("pluginConnectionTypeId", () => {
  it("namespaces the connection type by plugin id (PLG-007)", () => {
    expect(pluginConnectionTypeId("k8s-tools", "k8s")).toBe("plugin:k8s-tools:k8s");
  });

  it("gives two plugins declaring the same type distinct ids", () => {
    expect(pluginConnectionTypeId("alpha", "k8s")).not.toBe(pluginConnectionTypeId("beta", "k8s"));
  });
});

describe("parsePluginConnectionTypeId", () => {
  it("splits a namespaced id at the first colon after the prefix", () => {
    expect(parsePluginConnectionTypeId("plugin:acme:k8s")).toEqual({
      pluginId: "acme",
      connectionType: "k8s",
    });
    expect(parsePluginConnectionTypeId("plugin:acme:a:b")).toEqual({
      pluginId: "acme",
      connectionType: "a:b",
    });
  });

  it("rejects built-in, legacy and malformed ids", () => {
    for (const id of ["ssh", "k8s-acme", "plugin:", "plugin:acme", "plugin::k8s", "plugin:acme:"]) {
      expect(parsePluginConnectionTypeId(id)).toBeNull();
    }
  });
});

describe("pluginConnectionIssue", () => {
  it("is null for built-in types and for an active plugin providing the type", () => {
    expect(pluginConnectionIssue("ssh", [])).toBeNull();
    expect(pluginConnectionIssue("plugin:acme:k8s", [backendPlugin("acme", "k8s")])).toBeNull();
  });

  it("names a plugin that is not installed", () => {
    const issue = pluginConnectionIssue("plugin:acme:k8s", []);
    expect(issue).toMatchObject({ pluginId: "acme", installed: false, reason: "not-installed" });
    expect(issue?.message).toBe("Plugin 'acme' is not installed");
  });

  it("distinguishes disabled, untrusted, failed and incompatible plugins", () => {
    const cases: [PluginState, string, string][] = [
      ["disabled", "disabled", "Plugin 'Acme K8s' is disabled"],
      ["installed", "not-loaded", "Plugin 'Acme K8s' is not loaded"],
      ["error", "error", "Plugin 'Acme K8s' failed to load"],
      ["incompatible", "incompatible", "Plugin 'Acme K8s' is incompatible"],
    ];
    for (const [state, reason, prefix] of cases) {
      const issue = pluginConnectionIssue("plugin:acme:k8s", [
        backendPlugin("acme", "k8s", state, "Acme K8s"),
      ]);
      expect(issue).toMatchObject({ installed: true, reason, pluginName: "Acme K8s" });
      expect(issue?.message.startsWith(prefix)).toBe(true);
    }
  });

  it("includes the activation error detail", () => {
    const plugin = { ...backendPlugin("acme", "k8s", "error"), errorMessage: "bad lib" };
    expect(pluginConnectionIssue("plugin:acme:k8s", [plugin])?.message).toBe(
      "Plugin 'acme' failed to load: bad lib"
    );
  });

  it("flags an active plugin that no longer declares the type", () => {
    const issue = pluginConnectionIssue("plugin:acme:k8s", [backendPlugin("acme", "mqtt")]);
    expect(issue?.reason).toBe("type-missing");
  });
});
