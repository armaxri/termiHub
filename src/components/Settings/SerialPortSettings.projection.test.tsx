/**
 * `SerialPortSettings` render-cut parity (#2227). Proves the settings screen reader
 * sources its document from the projected `settings` region: with the render flag
 * on and the region a faithful mirror of `appStore`, the panel renders the
 * projected serial-port prefixes; when the region cannot catch up it falls back to
 * `appStore` verbatim, so the output is byte-identical to the pre-cut path.
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
import { TooltipProvider } from "@/components/ui";
import type { AppSettings } from "@/types/connection";
import {
  SETTINGS_REGION,
  setSettingsRenderFromProjectionEnabled,
  setSettingsTransportForTest,
  stopSettingsSubscription,
} from "@/store/settingsBridge";

import { SerialPortSettings } from "./SerialPortSettings";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

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

function render() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <SerialPortSettings />
      </TooltipProvider>
    );
  });
}

function prefixItems(): string[] {
  return Array.from(container.querySelectorAll(".settings-panel__file-path")).map(
    (el) => el.textContent ?? ""
  );
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

describe("SerialPortSettings render cut (#2227)", () => {
  it("renders the prefixes sourced from the projected region", async () => {
    useAppStore.setState({
      settings: settings({
        serialPortScanPrefixes: [
          { prefix: "ttyAMA", enabled: true, builtIn: true },
          { prefix: "ttyXYZ", enabled: false, builtIn: false },
        ],
      }),
    });

    render();
    await flush();
    await flush();

    // The panel seeded the region and now renders the projected prefixes.
    expect(transport.dispatched.some((d) => d.kind === "settings.replace")).toBe(true);
    expect(prefixItems()).toEqual(["ttyAMA", "ttyXYZ"]);
  });

  it("falls back to the appStore document when the region cannot catch up", async () => {
    transport.applyReplace = false; // acks but never advances the region
    useAppStore.setState({
      settings: settings({
        serialPortScanPrefixes: [{ prefix: "ttyBACKUP", enabled: true, builtIn: true }],
      }),
    });

    render();
    await flush();
    await flush();

    // Gate rejects the stale projection → appStore verbatim, parity preserved.
    expect(prefixItems()).toEqual(["ttyBACKUP"]);
  });
});
