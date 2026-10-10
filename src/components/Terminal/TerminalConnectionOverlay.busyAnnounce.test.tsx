/**
 * Every busy variant of the terminal connection overlay (#4512) is announced
 * through the always-mounted polite live region — mounted empty, then filled —
 * and never through a live heading, so screen readers speak it exactly once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: () => Promise.resolve(),
}));

import { TerminalConnectionOverlay } from "./TerminalConnectionOverlay";
import { useAppStore } from "@/store/appStore";
import {
  connected,
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { ProjectedSessionLifecycle } from "@/store/sessionBridge";

const TAB_ID = "tab-busy";
const PANEL_ID = "panel-busy";

const harness = installSessionLifecycleHarness();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState({
    terminalSpawnErrors: {},
    terminalSpawnErrorKinds: {},
    terminalAutoRetryCount: {},
    terminalWaitingForAgent: {},
    terminalRetryCounters: {},
    terminalReattaching: {},
    terminalConnectDeadline: {},
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function overlay() {
  return (
    <TerminalConnectionOverlay
      tabId={TAB_ID}
      panelId={PANEL_ID}
      tabTitle="build-host"
      isVisible={true}
    />
  );
}

function liveRegion(): HTMLElement | null {
  return container.querySelector("[data-testid='content-overlay-live']");
}

function heading(): HTMLElement | null {
  return container.querySelector(".ui-content-overlay__heading");
}

interface Variant {
  name: string;
  life: ProjectedSessionLifecycle;
  store: Partial<ReturnType<typeof useAppStore.getState>>;
  heading: string;
  announcement: string;
}

const VARIANTS: Variant[] = [
  {
    name: "connecting",
    life: connecting(),
    store: {},
    heading: "Connecting…",
    announcement: "Connecting… build-host",
  },
  {
    name: "auto-retry connecting",
    life: connected(),
    store: { terminalAutoRetryCount: { [TAB_ID]: 2 } },
    heading: "Connecting… (attempt 3)",
    announcement: "Connecting… (attempt 3). build-host",
  },
  {
    name: "waiting for agent",
    life: connected(),
    store: { terminalWaitingForAgent: { [TAB_ID]: "agent-1" } },
    heading: "Waiting for agent…",
    announcement:
      "Waiting for agent… Waiting for the agent to connect before starting the session.",
  },
  {
    name: "restoring session",
    life: connected(),
    store: { terminalReattaching: { [TAB_ID]: true } },
    heading: "Restoring session…",
    announcement: "Restoring session… Loading cached scrollback from the persistent session.",
  },
];

describe.each(VARIANTS)("TerminalConnectionOverlay busy variant: $name (#4512)", (variant) => {
  async function render(): Promise<void> {
    harness.transport.setSession(TAB_ID, variant.life);
    useAppStore.setState(variant.store);
    act(() => root.render(overlay()));
    await flushSessionRegion();
  }

  it("announces through a polite live region, never through the heading", async () => {
    await render();
    expect(heading()?.textContent).toBe(variant.heading);
    expect(heading()?.getAttribute("role")).toBeNull();
    expect(heading()?.getAttribute("aria-live")).toBeNull();
    expect(liveRegion()?.getAttribute("role")).toBe("status");
    expect(liveRegion()?.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion()?.textContent).toBe(variant.announcement);
    const announcing = container.querySelectorAll("[role='status'], [role='alert'], [aria-live]");
    expect(announcing).toHaveLength(1);
  });

  it("mounts the region before its text", async () => {
    harness.transport.setSession(TAB_ID, variant.life);
    useAppStore.setState(variant.store);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => records.push(...recs));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    act(() => root.render(overlay()));
    await flushSessionRegion();
    records.push(...observer.takeRecords());
    observer.disconnect();
    const region = liveRegion();
    expect(region?.textContent).toBe(variant.announcement);
    const textAdds = records.filter(
      (r) => r.target === region && r.type === "childList" && r.addedNodes.length > 0
    );
    expect(textAdds.length).toBeGreaterThan(0);
  });

  it("does not re-announce on unchanged re-renders", async () => {
    await render();
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((recs) => mutations.push(...recs));
    observer.observe(liveRegion() as HTMLElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    for (let i = 0; i < 3; i++) act(() => root.render(overlay()));
    await flushSessionRegion();
    observer.disconnect();
    expect(mutations).toHaveLength(0);
  });
});
