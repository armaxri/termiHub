/**
 * Type-level checks for the plugin frontend types (#1993).
 *
 * These construct fully-typed sample values that mirror the Rust manifest model
 * (`core/src/plugin/manifest.rs`) and the concept's §6 shapes. Because the
 * values are annotated with the exported interfaces, any drift in the type
 * definitions (a renamed/removed field, a widened union) fails `tsc` during the
 * build — the runtime assertions are secondary, the compile-time shape is the point.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  PluginManifest,
  PluginPermission,
  PluginPlatform,
  PluginExtensions,
  TerminalBackendExtension,
  ProtocolParserExtension,
  ThemeExtension,
  ThemeEntry,
  StatusBarWidgetExtension,
  WidgetPosition,
  PluginState,
  InstalledPlugin,
  PluginSettingSchema,
  PluginSettingType,
  PluginBackendType,
} from "./plugin";

/** A manifest exercising every extension point and a settings block. */
function sampleManifest(): PluginManifest {
  const terminalBackend: TerminalBackendExtension = {
    connectionType: "k8s-exec",
    displayName: "Kubernetes Exec",
    configSchema: {
      type: "object",
      properties: { pod: { type: "string" } },
      required: ["pod"],
    },
  };
  const protocolParser: ProtocolParserExtension = {
    name: "ansi-annotate",
    description: "Annotates output",
    entryPoint: "frontend/index.js",
  };
  const themeEntry: ThemeEntry = { id: "dracula", name: "Dracula", file: "dracula.json" };
  const theme: ThemeExtension = { themes: [themeEntry] };
  const statusBarWidget: StatusBarWidgetExtension = {
    entryPoint: "frontend/widget.js",
    position: "right",
  };
  const extensions: PluginExtensions = {
    terminalBackend,
    protocolParser,
    theme,
    statusBarWidget,
  };
  const setting: PluginSettingSchema = {
    type: "string",
    default: "default",
    description: "Default Kubernetes namespace",
    enum: ["default", "kube-system"],
  };
  return {
    id: "k8s-exec",
    name: "Kubernetes Exec",
    version: "1.2.0",
    author: "k8s-contrib",
    description: "Terminal backend for Kubernetes pod exec sessions",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["windows", "linux", "macos"],
    permissions: ["terminal", "network", "filesystem"],
    extensions,
    settings: { defaultNamespace: setting },
  };
}

describe("plugin types (#1993)", () => {
  it("constructs a full manifest mirroring the Rust model", () => {
    const manifest = sampleManifest();
    expect(manifest.id).toBe("k8s-exec");
    expect(manifest.platforms).toHaveLength(3);
    expect(manifest.permissions).toContain("terminal");
    expect(manifest.extensions.terminalBackend?.connectionType).toBe("k8s-exec");
    expect(manifest.extensions.theme?.themes[0].file).toBe("dracula.json");
    expect(manifest.settings?.defaultNamespace.type).toBe("string");
  });

  it("allows a minimal manifest with a single extension and no settings", () => {
    const manifest: PluginManifest = {
      id: "just-theme",
      name: "Just a Theme",
      version: "0.1.0",
      author: "someone",
      description: "A theme-only plugin",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["linux"],
      permissions: [],
      extensions: { theme: { themes: [{ id: "t", name: "T", file: "t.json" }] } },
    };
    expect(manifest.settings).toBeUndefined();
    expect(manifest.extensions.terminalBackend).toBeUndefined();
  });

  it("models an installed plugin's state and error detail", () => {
    const installed: InstalledPlugin = {
      manifest: sampleManifest(),
      state: "active",
      installedAt: "2026-07-26T00:00:00Z",
    };
    const errored: InstalledPlugin = {
      manifest: sampleManifest(),
      state: "error",
      errorMessage: "failed to load library",
      installedAt: "2026-07-26T00:00:00Z",
    };
    expect(installed.state).toBe("active");
    expect(errored.errorMessage).toBe("failed to load library");
  });

  it("pins the closed unions to their manifest-mirroring members", () => {
    expectTypeOf<PluginPermission>().toEqualTypeOf<
      "terminal" | "network" | "filesystem" | "ui" | "settings"
    >();
    expectTypeOf<PluginPlatform>().toEqualTypeOf<"windows" | "linux" | "macos">();
    expectTypeOf<WidgetPosition>().toEqualTypeOf<"left" | "right">();
    expectTypeOf<PluginSettingType>().toEqualTypeOf<"string" | "number" | "boolean">();
    expectTypeOf<PluginState>().toEqualTypeOf<
      "installed" | "active" | "disabled" | "error" | "incompatible"
    >();
  });

  it("shapes a derived plugin backend type", () => {
    const backendType: PluginBackendType = {
      pluginId: "k8s-exec",
      connectionType: "k8s-exec",
      displayName: "Kubernetes Exec",
    };
    expect(backendType.pluginId).toBe("k8s-exec");
    expectTypeOf(backendType).toMatchTypeOf<{
      pluginId: string;
      connectionType: string;
      displayName: string;
    }>();
  });
});
