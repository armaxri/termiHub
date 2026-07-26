/**
 * Unit tests for the plugin presentation helpers (#1997) — the pure mappings
 * from the plugin data model to dot state, labels, extension points, and
 * permission text used across the Plugin Manager UI.
 */
import { describe, it, expect } from "vitest";
import type { PluginExtensions, PluginManifest } from "@/types/plugin";
import type { PluginTrustInfo } from "@/types/plugin";
import {
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  extensionPoints,
  fingerprintShort,
  hasSettings,
  pluginDotState,
  pluginStatusLabel,
  pluginTypeLabel,
  trustBanner,
} from "./pluginPresentation";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "p",
    name: "Plugin",
    version: "1.0.0",
    author: "me",
    description: "",
    license: "MIT",
    apiVersion: "1.0",
    platforms: ["macos"],
    permissions: [],
    extensions: {},
    ...overrides,
  };
}

describe("pluginDotState", () => {
  it("maps active to enabled", () => {
    expect(pluginDotState("active")).toBe("enabled");
  });

  it("maps installed/disabled to disabled", () => {
    expect(pluginDotState("installed")).toBe("disabled");
    expect(pluginDotState("disabled")).toBe("disabled");
  });

  it("maps error and incompatible to error", () => {
    expect(pluginDotState("error")).toBe("error");
    expect(pluginDotState("incompatible")).toBe("error");
  });
});

describe("pluginStatusLabel", () => {
  it("labels each state", () => {
    expect(pluginStatusLabel("active")).toBe("Enabled");
    expect(pluginStatusLabel("disabled")).toBe("Disabled");
    expect(pluginStatusLabel("installed")).toBe("Disabled");
    expect(pluginStatusLabel("error")).toBe("Error");
    expect(pluginStatusLabel("incompatible")).toBe("Incompatible");
  });
});

describe("pluginTypeLabel", () => {
  it("picks the primary extension in priority order", () => {
    const ext: PluginExtensions = {
      terminalBackend: { connectionType: "k8s", displayName: "K8s", configSchema: {} },
      theme: { themes: [] },
    };
    expect(pluginTypeLabel(ext)).toBe("terminal backend");
    expect(pluginTypeLabel({ theme: { themes: [] } })).toBe("theme");
    expect(
      pluginTypeLabel({ protocolParser: { name: "n", description: "", entryPoint: "e" } })
    ).toBe("protocol parser");
    expect(pluginTypeLabel({})).toBe("plugin");
  });
});

describe("extensionPoints", () => {
  it("enumerates each declared extension with its detail", () => {
    const points = extensionPoints({
      terminalBackend: { connectionType: "k8s-exec", displayName: "K8s", configSchema: {} },
      protocolParser: { name: "colorize", description: "", entryPoint: "e" },
      theme: { themes: [{ id: "a", name: "A", file: "a.json" }] },
    });
    expect(points.map((p) => p.key)).toEqual(["terminalBackend", "protocolParser", "theme"]);
    expect(points[0].detail).toBe("k8s-exec");
    expect(points[2].detail).toBe("1 theme");
  });

  it("returns an empty array for no extensions", () => {
    expect(extensionPoints({})).toEqual([]);
  });
});

describe("permission text", () => {
  it("has a label and description for every permission", () => {
    for (const perm of ["terminal", "network", "filesystem", "ui", "settings"] as const) {
      expect(PERMISSION_LABELS[perm]).toBeTruthy();
      expect(PERMISSION_DESCRIPTIONS[perm]).toBeTruthy();
    }
    expect(PERMISSION_LABELS.filesystem).toBe("FileSystem");
  });
});

describe("hasSettings", () => {
  it("is false when no settings are declared", () => {
    expect(hasSettings(manifest())).toBe(false);
    expect(hasSettings(manifest({ settings: {} }))).toBe(false);
  });

  it("is true when at least one setting is declared", () => {
    expect(
      hasSettings(manifest({ settings: { ns: { type: "string", default: "", description: "" } } }))
    ).toBe(true);
  });
});

describe("fingerprintShort", () => {
  it("truncates a long sha256 fingerprint to head…tail", () => {
    expect(fingerprintShort("sha256:ab12cd34ef56ab12cd34ef569f0e9f0e")).toBe("sha256:ab12…9f0e");
  });

  it("returns short or empty values unchanged", () => {
    expect(fingerprintShort("sha256:ab12")).toBe("sha256:ab12");
    expect(fingerprintShort(null)).toBe("");
    expect(fingerprintShort(undefined)).toBe("");
  });
});

describe("trustBanner", () => {
  function trust(overrides: Partial<PluginTrustInfo> = {}): PluginTrustInfo {
    return {
      level: "untrusted",
      warning: "unsigned warning",
      keyId: null,
      publisher: null,
      publicKey: null,
      requiresAcceptance: true,
      isBlocked: false,
      ...overrides,
    };
  }

  it("maps verified to a success banner naming the publisher and fingerprint", () => {
    const b = trustBanner(
      trust({
        level: "verified",
        warning: "",
        publisher: "ACME",
        keyId: "sha256:ab12cd34ef56ab129f0e",
      })
    );
    expect(b.tone).toBe("verified");
    expect(b.title).toBe("Verified publisher");
    expect(b.description).toContain("ACME");
    expect(b.description).toContain("sha256:ab12…");
  });

  it("maps signed to a warning banner with the fingerprint", () => {
    const b = trustBanner(
      trust({ level: "signed", warning: "", keyId: "sha256:77de11aa22bb1a3c" })
    );
    expect(b.tone).toBe("warning");
    expect(b.title).toBe("Signed — new publisher");
  });

  it("maps untrusted to a warning banner and tampered to a danger banner", () => {
    expect(trustBanner(trust({ level: "untrusted" })).tone).toBe("warning");
    const t = trustBanner(trust({ level: "tampered", warning: "blocked", isBlocked: true }));
    expect(t.tone).toBe("danger");
    expect(t.title).toBe("Signature invalid");
  });
});
