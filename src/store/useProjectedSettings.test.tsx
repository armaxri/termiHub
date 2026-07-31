/**
 * `useProjectedSettings` — the Settings screen cut to the projected `settings`
 * region (#2227 render cut). Drives the hook against an in-memory substrate double
 * and asserts: flag-off returns the appStore document and dispatches nothing;
 * flag-on seeds the region (a `settings.replace` mirror) and then renders the
 * document from the projection, value-identical to appStore; and a region that has
 * not caught up falls back to the appStore document.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import type { AppSettings } from "@/types/connection";

import {
  SETTINGS_REGION,
  setSettingsRenderFromProjectionEnabled,
  setSettingsTransportForTest,
  settingsViewMirrors,
  stopSettingsSubscription,
} from "./settingsBridge";
import { useProjectedSettings } from "./useProjectedSettings";

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    ...overrides,
  };
}

/** In-memory substrate double: applies `settings.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `settings.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: Record<string, unknown> = { version: "1", externalConnectionFiles: [] };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "settings.replace" && this.applyReplace) {
      const p = intent.payload as Record<string, unknown>;
      this.view = (p.settings ?? {}) as Record<string, unknown>;
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: SETTINGS_REGION, version: this.version }],
    };
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
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(SETTINGS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => AppSettings; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: AppSettings = settings();

  function Probe() {
    latest = useProjectedSettings();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setSettingsTransportForTest(transport);
  useAppStore.setState({ settings: settings() });
});

afterEach(() => {
  stopSettingsSubscription();
  setSettingsTransportForTest(null);
  setSettingsRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedSettings", () => {
  it("flag off: returns the appStore document and dispatches nothing", async () => {
    setSettingsRenderFromProjectionEnabled(false);
    useAppStore.setState({ settings: settings({ theme: "light", fontSize: 18 }) });

    const hook = renderHook();
    await flush();

    expect(hook.get().theme).toBe("light");
    expect(hook.get().fontSize).toBe(18);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the document from the projection", async () => {
    const doc = settings({ theme: "solarized-dark", fontSize: 15, cursorBlink: true });
    useAppStore.setState({ settings: doc });

    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's document via settings.replace…
    expect(transport.dispatched.some((d) => d.kind === "settings.replace")).toBe(true);
    // …and now renders a value-identical document (sourced from the projection).
    expect(hook.get()).toEqual(doc);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore document", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const doc = settings({ theme: "light", fontFamily: "Fira Code" });
    useAppStore.setState({ settings: doc });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays behind, so the gate rejects it and the hook renders the
    // appStore document verbatim — parity preserved.
    expect(hook.get()).toEqual(doc);
    hook.unmount();
  });
});

describe("settingsViewMirrors", () => {
  it("is false for an undefined view", () => {
    expect(settingsViewMirrors(undefined, settings())).toBe(false);
  });

  it("is true only when the view deep-equals the appStore document", () => {
    const a = settings({ theme: "dark", sessionHistoryLimit: 50 });
    expect(settingsViewMirrors(settings({ theme: "dark", sessionHistoryLimit: 50 }), a)).toBe(true);
    expect(settingsViewMirrors(settings({ theme: "light", sessionHistoryLimit: 50 }), a)).toBe(
      false
    );
    expect(settingsViewMirrors(settings({ theme: "dark", sessionHistoryLimit: 99 }), a)).toBe(
      false
    );
    // A view that carries an extra key is not a faithful mirror.
    expect(
      settingsViewMirrors(settings({ theme: "dark", sessionHistoryLimit: 50, fontSize: 14 }), a)
    ).toBe(false);
  });
});
