/**
 * `useExperimentalFeatures` region-authoritative read (#2227). Proves a
 * settings-driven behavior reader sources its value from the authoritative
 * `settings` projection region: seeded with `experimentalFeaturesEnabled`, the hook
 * returns the projected value; unset projects to the pre-cut default of `false`.
 *
 * Representative of the behavior-reader subset (#2269) — every reader routes
 * through the same `useProjectedSettings()` hook, so the region-sourced behavior
 * proven here holds for all of them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useAppStore } from "@/store/appStore";
import {
  FakeSettingsTransport,
  installSettingsHarness,
  settingsDoc,
} from "@/test/settingsRegionTestHarness";

import { useExperimentalFeatures } from "./useExperimentalFeatures";

let container: HTMLDivElement;
let root: Root;
let harness: { transport: FakeSettingsTransport; teardown: () => void };

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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  harness?.teardown();
  vi.clearAllMocks();
});

describe("useExperimentalFeatures region read (#2227)", () => {
  it("returns the value sourced from the projected region", async () => {
    harness = installSettingsHarness(settingsDoc({ experimentalFeaturesEnabled: true }));

    render();
    await flush();
    await flush();

    expect(value()).toBe("true");
  });

  it("defaults to false when the setting is unset (parity with the pre-cut read)", async () => {
    harness = installSettingsHarness(settingsDoc());

    render();
    await flush();
    await flush();

    expect(value()).toBe("false");
  });
});
