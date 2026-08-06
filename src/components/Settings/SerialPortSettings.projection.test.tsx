/**
 * `SerialPortSettings` region-authoritative render (#2227). Proves the settings
 * screen reader sources its document from the authoritative `settings` projection
 * region: seeded with serial-port prefixes, the panel renders them; a later region
 * diff re-renders the panel. No `appStore` fallback — the region is the source of
 * truth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import {
  FakeSettingsTransport,
  installSettingsHarness,
  settingsDoc,
} from "@/test/settingsRegionTestHarness";

import { SerialPortSettings } from "./SerialPortSettings";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

let container: HTMLDivElement;
let root: Root;
let harness: { transport: FakeSettingsTransport; teardown: () => void };

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  harness?.teardown();
  vi.clearAllMocks();
});

describe("SerialPortSettings region render (#2227)", () => {
  it("renders the prefixes sourced from the projected region", async () => {
    harness = installSettingsHarness(
      settingsDoc({
        serialPortScanPrefixes: [
          { prefix: "ttyAMA", enabled: true, builtIn: true },
          { prefix: "ttyXYZ", enabled: false, builtIn: false },
        ],
      })
    );

    render();
    await flush();
    await flush();

    expect(prefixItems()).toEqual(["ttyAMA", "ttyXYZ"]);
  });

  it("re-renders when the region projects a new document", async () => {
    harness = installSettingsHarness(
      settingsDoc({
        serialPortScanPrefixes: [{ prefix: "ttyBACKUP", enabled: true, builtIn: true }],
      })
    );

    render();
    await flush();
    await flush();
    expect(prefixItems()).toEqual(["ttyBACKUP"]);

    act(() =>
      harness.transport.seed(
        settingsDoc({
          serialPortScanPrefixes: [{ prefix: "ttyUPDATED", enabled: true, builtIn: true }],
        })
      )
    );
    await flush();

    expect(prefixItems()).toEqual(["ttyUPDATED"]);
  });
});
