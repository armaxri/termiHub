/**
 * Settings mutation cut (#2227, part of #2139 and #2153) — cut-vs-local parity.
 *
 * The mutation cut routes the settings setters through the `settings.*` intents so
 * the backend `SettingsStore` becomes authoritative, while the local `appStore`
 * reducer path stays in place as the render source and the resilience / rollback
 * fallback (the reducer removal is a later step).
 *
 * These tests prove the cut is parity-safe end to end: with the flag **on**, the
 * intents dispatched by the setters — applied by a faithful in-memory port of the
 * Rust store (mirroring `settings_projection/store.rs`) — reproduce the exact
 * `appStore` settings document (`settings`) for every setter and its fan-out. They
 * also assert the **persistence side-effect is untouched** — `saveSettings` /
 * `save_shell_integration_settings` still fire with the same payload the intent
 * carries. With the flag **off**, no intents are dispatched and the local document
 * is byte-identical — the instant rollback path the flip relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  persistAgent: vi.fn(() => Promise.resolve()),
  removeAgent: vi.fn(() => Promise.resolve()),
  reorderAgents: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
      updates: { skippedVersion: undefined },
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  saveShellIntegrationSettings: vi.fn(() => Promise.resolve({})),
  skipUpdateVersion: vi.fn(() => Promise.resolve()),
  clearSkippedVersion: vi.fn(() => Promise.resolve()),
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
  getConnectionTypes: vi.fn(() => Promise.resolve([])),
}));

import { useAppStore } from "./appStore";
import { saveSettings } from "@/services/storage";
import { saveShellIntegrationSettings } from "@/services/api";
import { setSettingsIntentsEnabled, setSettingsTransportForTest } from "./settingsBridge";
import type { AppSettings, ShellIntegrationSettings } from "@/types/connection";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";

/** The frontend default settings baseline — mirrors `default_settings_document()`
 * in `settings_projection/store.rs`, used to service `settings.reset`. */
function defaultSettingsDocument(): AppSettings {
  return {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    confirmCloseTabOnShortcut: true,
    confirmCloseLiveSession: true,
    confirmCloseAttachedTab: true,
    askOpenSavedFileInTab: true,
    warnLargePortScan: true,
    warnLargePingSweep: true,
  } as AppSettings;
}

function shellIntegration(registered: boolean): ShellIntegrationSettings {
  return {
    entries: [],
    fallback: "prompt",
    openInNewWindow: false,
    registered,
    linuxFileManagers: {},
    firstLaunchBannerDismissed: false,
  } as unknown as ShellIntegrationSettings;
}

/**
 * An in-memory substrate double that applies the `settings.*` intents with the same
 * semantics as the Rust `SettingsStore`, so a run of the real `appStore` setters
 * (which mirror those intents) reconstructs the settings document the Settings UI
 * would render. `settings.replace` overwrites the whole document, `settings.patch`
 * shallow-merges each top-level key, and `settings.reset` restores the default
 * baseline.
 */
class SettingsStoreTransport implements Transport {
  dispatched: Intent[] = [];
  private doc: Record<string, unknown> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  /** Seed the region to a starting document without recording a user intent, so a
   * relative `settings.patch` has the same base the appStore slice does. */
  seed(settings: AppSettings): void {
    this.doc = structuredClone(settings) as unknown as Record<string, unknown>;
    this.version += 1;
    this.fan();
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    this.apply(intent);
    this.version += 1;
    this.fan();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: "settings", version: this.version }],
    };
  }

  private apply(intent: Intent): void {
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "settings.replace": {
        this.doc = structuredClone(p.settings as Record<string, unknown>);
        break;
      }
      case "settings.patch": {
        // Faithful to the backend route: the partial lives under a `{ patch }`
        // envelope (settings_projection/projection.rs), not the payload root.
        const patch = structuredClone((p.patch ?? {}) as Record<string, unknown>);
        for (const [key, value] of Object.entries(patch)) {
          this.doc[key] = value;
        }
        break;
      }
      case "settings.reset": {
        this.doc = structuredClone(defaultSettingsDocument()) as unknown as Record<string, unknown>;
        break;
      }
      default:
        break;
    }
  }

  /** The reconstructed settings document, twin of the store snapshot. */
  regionView(): AppSettings {
    return structuredClone(this.doc) as unknown as AppSettings;
  }

  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: this.regionView() };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot("settings");
    for (const h of this.handlers) h(frame);
  }
}

let transport: SettingsStoreTransport;

/** Assert the document the intents reconstruct equals the local appStore slice. */
function expectParity() {
  expect(transport.regionView()).toEqual(useAppStore.getState().settings);
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
  transport = new SettingsStoreTransport();
  setSettingsTransportForTest(transport);
  setSettingsIntentsEnabled(true);
  // Seed the region to appStore's initial document so a relative patch is in parity.
  transport.seed(useAppStore.getState().settings);
});

afterEach(() => {
  setSettingsTransportForTest(null);
  setSettingsIntentsEnabled(null);
});

describe("settings mutation cut — cut-vs-local parity (flag on)", () => {
  it("updateSettings replaces the whole document in the region", async () => {
    const next = { ...defaultSettingsDocument(), confirmCloseTabOnShortcut: false };

    await useAppStore.getState().updateSettings(next);

    expect(transport.kinds()).toEqual(["settings.replace"]);
    expectParity();
    expect(transport.regionView().confirmCloseTabOnShortcut).toBe(false);
  });

  it("updateSettings still persists through saveSettings (persistence parity)", async () => {
    const next = { ...defaultSettingsDocument(), askOpenSavedFileInTab: false };

    await useAppStore.getState().updateSettings(next);

    // The persist side-effect is untouched — it fires with the same document the
    // settings.replace intent carries.
    expect(vi.mocked(saveSettings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveSettings)).toHaveBeenCalledWith(next);
    expect(transport.regionView()).toEqual(next);
  });

  it("successive updateSettings calls stay in parity", async () => {
    await useAppStore.getState().updateSettings({
      ...defaultSettingsDocument(),
      warnLargePortScan: false,
    });
    expectParity();
    await useAppStore.getState().updateSettings({
      ...defaultSettingsDocument(),
      warnLargePortScan: false,
      warnLargePingSweep: false,
    });
    expectParity();
    expect(transport.kinds()).toEqual(["settings.replace", "settings.replace"]);
  });

  it("updateShellIntegration patches the shellIntegration field in the region", async () => {
    const si = shellIntegration(true);

    await useAppStore.getState().updateShellIntegration(si);

    expect(transport.kinds()).toEqual(["settings.patch"]);
    expectParity();
    expect(transport.regionView().shellIntegration).toEqual(si);
    // Persistence parity — the dedicated command still fires with the field value.
    expect(vi.mocked(saveShellIntegrationSettings)).toHaveBeenCalledWith(si);
  });

  it("updateShellIntegration rolls the region back on a persist failure", async () => {
    // Seed a previously-persisted shell-integration value.
    const prev = shellIntegration(false);
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings, shellIntegration: prev },
      savedSettings: { ...useAppStore.getState().savedSettings, shellIntegration: prev },
    });
    transport.seed(useAppStore.getState().settings);

    vi.mocked(saveShellIntegrationSettings).mockRejectedValueOnce(new Error("backend down"));

    await expect(
      useAppStore.getState().updateShellIntegration(shellIntegration(true))
    ).rejects.toThrow("backend down");

    // The optimistic patch was reverted in both the appStore slice and the region.
    expectParity();
    expect(transport.regionView().shellIntegration).toEqual(prev);
    expect(transport.kinds()).toEqual(["settings.patch", "settings.patch"]);
  });

  it("skipUpdate mirrors the refreshed settings as a replace", async () => {
    useAppStore.setState({
      updateInfo: { available: true, latestVersion: "9.9.9" } as never,
    });

    await useAppStore.getState().skipUpdate();

    expectParity();
    expect(transport.kinds()).toContain("settings.replace");
  });

  it("clearSkippedUpdateVersion mirrors the refreshed settings as a replace", async () => {
    await useAppStore.getState().clearSkippedUpdateVersion();

    expectParity();
    expect(transport.kinds()).toContain("settings.replace");
  });

  it("settings.reset restores the default baseline in the region", async () => {
    // Drift the region away from defaults, then reset.
    await useAppStore.getState().updateSettings({
      ...defaultSettingsDocument(),
      confirmCloseLiveSession: false,
    });
    expect(transport.regionView().confirmCloseLiveSession).toBe(false);

    await transport.dispatch({
      intentId: "reset-1",
      kind: "settings.reset",
      payload: {},
      clientId: "test",
    });

    expect(transport.regionView()).toEqual(defaultSettingsDocument());
  });

  it("a full settings lifecycle stays in parity across every step", async () => {
    await useAppStore.getState().updateSettings({
      ...defaultSettingsDocument(),
      confirmCloseTabOnShortcut: false,
    });
    expectParity();
    await useAppStore.getState().updateShellIntegration(shellIntegration(true));
    expectParity();
    await useAppStore.getState().updateSettings({
      ...useAppStore.getState().settings,
      askOpenSavedFileInTab: false,
    });
    expectParity();
  });
});

describe("settings mutation cut — flag off (rollback path)", () => {
  beforeEach(() => setSettingsIntentsEnabled(false));

  it("dispatches no intents and drives the slice locally", async () => {
    const dispatchedBefore = transport.dispatched.length;

    await useAppStore.getState().updateSettings({
      ...defaultSettingsDocument(),
      confirmCloseTabOnShortcut: false,
    });
    await useAppStore.getState().updateShellIntegration(shellIntegration(true));

    // No mutation intent reached the region — the pre-cut local path is intact.
    expect(transport.dispatched.length).toBe(dispatchedBefore);
    // The local slice still behaves exactly as before the cut.
    expect(useAppStore.getState().settings.confirmCloseTabOnShortcut).toBe(false);
    expect(useAppStore.getState().settings.shellIntegration).toEqual(shellIntegration(true));
    // Persistence is unchanged whether or not the cut is enabled.
    expect(vi.mocked(saveSettings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveShellIntegrationSettings)).toHaveBeenCalledTimes(1);
  });
});
