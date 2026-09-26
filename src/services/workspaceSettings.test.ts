import { describe, it, expect, vi, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";

import { applyTheme } from "@/themes";
import {
  getActiveWorkspace as apiGetActiveWorkspace,
  loadWorkspace as apiLoadWorkspace,
  saveWorkspace as apiSaveWorkspace,
  setActiveWorkspace as apiSetActiveWorkspace,
} from "@/services/workspaceApi";
import { SETTINGS_REGISTRY } from "@/components/Settings/settingsRegistry";
import { __emitSettingsViewForTest, setSettingsTransportForTest } from "@/store/settingsBridge";
import type { AppSettings } from "@/types/connection";
import type { ActiveWorkspaceInfo, WorkspaceDefinition } from "@/types/workspace";
import {
  ACTIVE_WORKSPACE_CHANGED_EVENT,
  WORKSPACE_OVERRIDABLE_SETTINGS,
  __resetActiveWorkspaceForTest,
  activateWorkspace,
  applyEffectiveTheme,
  clearWorkspaceOverride,
  currentEffectiveSettings,
  envVarRowError,
  getActiveWorkspace,
  initActiveWorkspaceSync,
  isOverriddenByWorkspace,
  isValidEnvVarName,
  looksLikeSecretName,
  normalizeWorkspaceSettings,
  primeActiveWorkspace,
  resolveEffectiveSettings,
  setActiveWorkspaceLocal,
  subscribeActiveWorkspace,
} from "./workspaceSettings";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

vi.mock("@/services/workspaceApi", () => ({
  getActiveWorkspace: vi.fn(),
  setActiveWorkspace: vi.fn(),
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
}));

const GLOBAL: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: true,
  fileBrowserEnabled: true,
  theme: "dark",
  fontFamily: "Menlo",
  fontSize: 14,
  lineHeight: 1.2,
};

const PROD: ActiveWorkspaceInfo = {
  id: "ws-prod",
  name: "Prod",
  settings: { theme: "light", fontSize: 18 },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveWorkspaceForTest();
  setSettingsTransportForTest(null);
});

describe("resolveEffectiveSettings (precedence global < workspace)", () => {
  it("returns the global document when no workspace is active", () => {
    expect(resolveEffectiveSettings(GLOBAL, null)).toBe(GLOBAL);
  });

  it("layers only the overridden keys over the global document", () => {
    const effective = resolveEffectiveSettings(GLOBAL, { theme: "light", fontSize: 18 });
    expect(effective.theme).toBe("light");
    expect(effective.fontSize).toBe(18);
    // Not overridden → inherited.
    expect(effective.fontFamily).toBe("Menlo");
    expect(effective.lineHeight).toBe(1.2);
    // The global document itself is never mutated.
    expect(GLOBAL.theme).toBe("dark");
  });

  it("ignores empty override values", () => {
    const effective = resolveEffectiveSettings(GLOBAL, { theme: "", fontFamily: "" });
    expect(effective.theme).toBe("dark");
    expect(effective.fontFamily).toBe("Menlo");
  });

  it("reflects the active workspace in currentEffectiveSettings", () => {
    __emitSettingsViewForTest(GLOBAL, 1);
    expect(currentEffectiveSettings().fontSize).toBe(14);
    setActiveWorkspaceLocal(PROD);
    expect(currentEffectiveSettings().fontSize).toBe(18);
  });
});

describe("isOverriddenByWorkspace", () => {
  it("reports only keys the workspace sets", () => {
    expect(isOverriddenByWorkspace(PROD, "theme")).toBe(true);
    expect(isOverriddenByWorkspace(PROD, "fontFamily")).toBe(false);
    expect(isOverriddenByWorkspace(null, "theme")).toBe(false);
  });
});

describe("live apply on workspace switch", () => {
  it("re-applies the effective theme when the active workspace changes", () => {
    __emitSettingsViewForTest(GLOBAL, 1);
    setActiveWorkspaceLocal(PROD);
    expect(applyTheme).toHaveBeenLastCalledWith("light", undefined);

    setActiveWorkspaceLocal(null);
    expect(applyTheme).toHaveBeenLastCalledWith("dark", undefined);
  });

  it("activateWorkspace marks it active on the backend and applies it here", async () => {
    vi.mocked(apiGetActiveWorkspace).mockResolvedValue(PROD);
    await activateWorkspace("ws-prod");
    expect(apiSetActiveWorkspace).toHaveBeenCalledWith("ws-prod");
    expect(getActiveWorkspace()).toEqual(PROD);
  });

  it("follows the backend broadcast in every window", async () => {
    vi.mocked(apiGetActiveWorkspace).mockResolvedValue(null);
    let handler: ((e: { payload: ActiveWorkspaceInfo | null }) => void) | undefined;
    vi.mocked(listen).mockImplementation(async (event, cb) => {
      expect(event).toBe(ACTIVE_WORKSPACE_CHANGED_EVENT);
      handler = cb as typeof handler;
      return () => {};
    });

    await initActiveWorkspaceSync();
    expect(getActiveWorkspace()).toBeNull();

    handler?.({ payload: PROD });
    expect(getActiveWorkspace()?.name).toBe("Prod");
    handler?.({ payload: null });
    expect(getActiveWorkspace()).toBeNull();
  });
});

describe("primeActiveWorkspace (#3517 startup, no theme flash)", () => {
  it("reads the backend's active workspace without applying a theme", async () => {
    vi.mocked(apiGetActiveWorkspace).mockResolvedValue(PROD);
    const listener = vi.fn();
    subscribeActiveWorkspace(listener);

    await primeActiveWorkspace();

    expect(getActiveWorkspace()).toEqual(PROD);
    expect(listener).toHaveBeenCalledTimes(1);
    // No global-theme apply yet — the caller's first apply includes the override.
    expect(applyTheme).not.toHaveBeenCalled();
    applyEffectiveTheme(GLOBAL);
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(applyTheme).toHaveBeenCalledWith("light", undefined);
  });

  it("leaves the state unchanged when the backend read fails", async () => {
    setActiveWorkspaceLocal(PROD);
    vi.mocked(apiGetActiveWorkspace).mockRejectedValue(new Error("down"));
    await primeActiveWorkspace();
    expect(getActiveWorkspace()).toEqual(PROD);
  });
});

describe("clearWorkspaceOverride (reset to global)", () => {
  it("removes only that key from the stored workspace", async () => {
    const def: WorkspaceDefinition = {
      id: "ws-prod",
      name: "Prod",
      tabGroups: [],
      settings: { theme: "light", fontSize: 18 },
    };
    vi.mocked(apiLoadWorkspace).mockResolvedValue(def);
    setActiveWorkspaceLocal(PROD);

    await clearWorkspaceOverride("ws-prod", "theme");

    expect(apiSaveWorkspace).toHaveBeenCalledWith({ ...def, settings: { fontSize: 18 } });
    expect(isOverriddenByWorkspace(getActiveWorkspace(), "theme")).toBe(false);
    expect(isOverriddenByWorkspace(getActiveWorkspace(), "fontSize")).toBe(true);
  });
});

describe("environment variable validation", () => {
  it("validates names like the backend", () => {
    expect(isValidEnvVarName("STAGE")).toBe(true);
    expect(isValidEnvVarName("_x1")).toBe(true);
    expect(isValidEnvVarName("1X")).toBe(false);
    expect(isValidEnvVarName("MY-VAR")).toBe(false);
    expect(isValidEnvVarName("")).toBe(false);
  });

  it("flags secret-looking names", () => {
    expect(looksLikeSecretName("DB_PASSWORD")).toBe(true);
    expect(looksLikeSecretName("GITHUB_TOKEN")).toBe(true);
    expect(looksLikeSecretName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(looksLikeSecretName("STAGE")).toBe(false);
  });

  it("reports invalid and duplicate rows but accepts blank rows", () => {
    const rows = [
      { key: "A", value: "1" },
      { key: "A", value: "2" },
      { key: "bad name", value: "" },
      { key: "", value: "" },
    ];
    expect(envVarRowError(rows, 0)).toBeNull();
    expect(envVarRowError(rows, 1)).toMatch(/Duplicate/);
    expect(envVarRowError(rows, 2)).toMatch(/letters/);
    expect(envVarRowError(rows, 3)).toBeNull();
  });
});

describe("normalizeWorkspaceSettings", () => {
  it("trims, drops blanks and returns undefined when nothing is overridden", () => {
    expect(
      normalizeWorkspaceSettings({ fontFamily: "  ", envVars: [{ key: "", value: "" }] })
    ).toBe(undefined);
    expect(
      normalizeWorkspaceSettings({
        theme: "light",
        defaultWorkingDirectory: " /srv ",
        envVars: [
          { key: " STAGE ", value: "prod" },
          { key: "", value: "" },
        ],
      })
    ).toEqual({
      theme: "light",
      defaultWorkingDirectory: "/srv",
      envVars: [{ key: "STAGE", value: "prod" }],
    });
  });

  it("rejects invalid env names and out-of-range font sizes", () => {
    expect(() => normalizeWorkspaceSettings({ envVars: [{ key: "1BAD", value: "" }] })).toThrow(
      /1BAD/
    );
    expect(() => normalizeWorkspaceSettings({ fontSize: 99 })).toThrow(/Font size/);
  });
});

describe("settings registry coverage", () => {
  it("every workspace-overridable key is a registered, searchable global setting", () => {
    const ids = new Set(SETTINGS_REGISTRY.map((s) => s.id));
    for (const key of WORKSPACE_OVERRIDABLE_SETTINGS) {
      expect(ids.has(key), `${key} missing from SETTINGS_REGISTRY`).toBe(true);
    }
  });
});
