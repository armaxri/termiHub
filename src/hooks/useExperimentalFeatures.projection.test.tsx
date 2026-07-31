/**
 * `useExperimentalFeatures` render-cut parity (#2269). Proves a settings-driven
 * behavior reader sources its value from the projected `settings` region: with the
 * render flag on and the region a faithful mirror of `appStore`, the hook returns
 * the projected `experimentalFeaturesEnabled`; when the region cannot catch up it
 * falls back to `appStore` verbatim, so the value is identical to the pre-cut path.
 *
 * Representative of the behavior-reader subset cut in #2269 — every reader now
 * routes through the same `useProjectedSettings()` hook, so the mirror + fallback
 * behavior proven here holds for all of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

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
  stopSettingsSubscription,
} from "@/store/settingsBridge";

import { useExperimentalFeatures } from "./useExperimentalFeatures";

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

let container: HTMLDivElement;
let root: Root;
let transport: FakeTransport;

const flush = () => act(async () => await Promise.resolve());

/** Renders the hook's boolean result into the DOM so it can be asserted. */
function Probe() {
  const enabled = useExperimentalFeatures();
  return <span data-testid="value">{String(enabled)}</span>;
}

function render() {
  act(() => {
    root.render(<Probe />);
  });
}

function value(): string {
  return container.querySelector('[data-testid="value"]')?.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
  transport = new FakeTransport();
  setSettingsTransportForTest(transport);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopSettingsSubscription();
  setSettingsTransportForTest(null);
  setSettingsRenderFromProjectionEnabled(null);
  vi.clearAllMocks();
});

describe("useExperimentalFeatures render cut (#2269)", () => {
  it("returns the value sourced from the projected region", async () => {
    useAppStore.setState({ settings: settings({ experimentalFeaturesEnabled: true }) });

    render();
    await flush();
    await flush();

    // The hook seeded the region and now reads the projected value.
    expect(transport.dispatched.some((d) => d.kind === "settings.replace")).toBe(true);
    expect(value()).toBe("true");
  });

  it("falls back to the appStore value when the region cannot catch up", async () => {
    transport.applyReplace = false; // acks but never advances the region
    useAppStore.setState({ settings: settings({ experimentalFeaturesEnabled: true }) });

    render();
    await flush();
    await flush();

    // Gate rejects the stale projection → appStore verbatim, parity preserved.
    expect(value()).toBe("true");
  });

  it("defaults to false when the setting is unset (parity with the pre-cut read)", async () => {
    useAppStore.setState({ settings: settings() });

    render();
    await flush();
    await flush();

    expect(value()).toBe("false");
  });
});
