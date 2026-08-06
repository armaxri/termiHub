/**
 * `useProjectedSettings` — reads the authoritative `settings` region (#2227). The
 * hook no longer falls back to `appStore` or gates on a faithful mirror: it renders
 * whatever the region projects. These tests seed the region via the shared harness
 * and assert the hook returns that document, updates on a subsequent diff, and
 * shows the default baseline before any diff has arrived.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  FakeSettingsTransport,
  installSettingsHarness,
  settingsDoc,
} from "@/test/settingsRegionTestHarness";
import type { AppSettings } from "@/types/connection";

import { DEFAULT_SETTINGS_VIEW } from "./settingsBridge";
import { useProjectedSettings } from "./useProjectedSettings";

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => AppSettings; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: AppSettings = settingsDoc();

  function Probe() {
    latest = useProjectedSettings();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let harness: { transport: FakeSettingsTransport; teardown: () => void };

const flush = () => act(async () => await Promise.resolve());

afterEach(() => {
  harness?.teardown();
});

describe("useProjectedSettings", () => {
  it("renders the document projected by the region", async () => {
    const doc = settingsDoc({ theme: "solarized-dark", fontSize: 15, cursorBlink: true });
    harness = installSettingsHarness(doc);

    const hook = renderHook();
    await flush();
    await flush();

    expect(hook.get()).toEqual(doc);
    hook.unmount();
  });

  it("updates when the region projects a new document", async () => {
    harness = installSettingsHarness(settingsDoc({ theme: "dark" }));

    const hook = renderHook();
    await flush();
    await flush();
    expect(hook.get().theme).toBe("dark");

    act(() => harness.transport.seed(settingsDoc({ theme: "light", fontSize: 18 })));
    await flush();

    expect(hook.get().theme).toBe("light");
    expect(hook.get().fontSize).toBe(18);
    hook.unmount();
  });

  it("shows the default baseline before any diff has arrived", () => {
    // Install the transport but do NOT seed — nothing has been projected yet.
    harness = installSettingsHarness();

    const hook = renderHook();
    // Synchronous initial render, before the subscribe promise resolves.
    expect(hook.get()).toEqual(DEFAULT_SETTINGS_VIEW);
    hook.unmount();
  });
});
