/**
 * `useLayoutRenderTree` — the renderer's cut to the projected layout render-list
 * (#2151 step 3). Drives the hook against a simulated `layout@<clientId>` region
 * and asserts: flag-off returns the appStore tree untouched and dispatches
 * nothing; flag-on seeds the region and then composes the render tree from the
 * projection (structure) + appStore (content), structurally identical to the
 * appStore tree; and a region that has not caught up falls back to the appStore
 * tree rather than render a stale structure.
 */
import { act } from "react";
import { flushMacrotask } from "@/test/flushAsync";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { LeafPanel, PanelNode, TerminalTab } from "@/types/terminal";

interface RegionState {
  version: number;
  view: unknown;
}

const { backend, dispatched } = vi.hoisted(() => ({
  backend: {
    version: -1,
    view: undefined as unknown,
    listeners: new Set<(s: RegionState) => void>(),
    /** When false, `layout.replace` is accepted but does NOT advance the region
     * (simulates a region that has not caught up to appStore). */
    applyReplace: true,
    push(view: unknown) {
      this.version += 1;
      this.view = view;
      const snapshot = { version: this.version, view: this.view };
      this.listeners.forEach((l) => l(snapshot));
    },
    reset() {
      this.version = -1;
      this.view = undefined;
      this.listeners.clear();
      this.applyReplace = true;
    },
  },
  dispatched: [] as { kind: string; payload: Record<string, unknown> }[],
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

vi.mock("@/services/transport", () => ({
  newClientId: () => "client-test",
  newIntentId: () => "intent-test",
  createTransport: () => ({
    async dispatch(intent: { kind: string; payload: Record<string, unknown> }) {
      dispatched.push({ kind: intent.kind, payload: intent.payload });
      if (intent.kind === "layout.replace" && backend.applyReplace) {
        backend.push({ root: intent.payload.root, activePanelId: intent.payload.activePanelId });
      }
      return {
        intentId: "intent-test",
        status: "accepted",
        produced: [{ region: "layout@client-test", version: backend.version }],
      };
    },
    subscribe: vi.fn(),
    resync: vi.fn(),
  }),
  ProjectionClient: class {
    constructor(
      _transport: unknown,
      public readonly region: string
    ) {}
    get state(): RegionState {
      return { version: backend.version, view: backend.view };
    }
    onChange(listener: (s: RegionState) => void) {
      backend.listeners.add(listener);
      return () => backend.listeners.delete(listener);
    }
    async start() {
      // The store seeds an unknown client's region to a single empty leaf.
      backend.push({
        root: { type: "leaf", id: "seed", tabs: [], activeTabId: null },
        activePanelId: "seed",
      });
    }
    stop() {}
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

import { useAppStore } from "./appStore";
import { setLayoutRenderFromProjectionEnabled, toMinimalNode } from "./layoutBridge";
import { useLayoutRenderTree } from "./useLayoutRenderTree";

function tab(id: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "a",
    isActive: id === "t1",
  } as TerminalTab;
}

function seedTree(): PanelNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    sizes: [50, 50],
    children: [
      { type: "leaf", id: "a", tabs: [tab("t1"), tab("t2")], activeTabId: "t1" },
      { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
    ] as LeafPanel[],
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: PanelNode | null = null;

function Probe() {
  latest = useLayoutRenderTree();
  return null;
}

async function mount() {
  await act(async () => {
    root.render(<Probe />);
  });
  // Let the async subscribe + seed + onChange settle.
  await act(async () => {
    await flushMacrotask();
    await flushMacrotask();
  });
}

describe("useLayoutRenderTree (#2151 step 3)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ rootPanel: seedTree(), activePanelId: "a" });
    backend.reset();
    dispatched.length = 0;
    latest = null;
    setLayoutRenderFromProjectionEnabled(null);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLayoutRenderFromProjectionEnabled(null);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("flag off: returns the appStore tree verbatim and dispatches nothing", async () => {
    setLayoutRenderFromProjectionEnabled(false);
    await mount();
    expect(dispatched).toHaveLength(0);
    expect(latest).toBe(useAppStore.getState().rootPanel);
  });

  it("flag on: seeds the region, then composes structure⊕content matching appStore", async () => {
    setLayoutRenderFromProjectionEnabled(true);
    await mount();

    // The initial snapshot was a single empty leaf (not a mirror) → the hook
    // seeded the region with appStore's tree.
    expect(dispatched.map((d) => d.kind)).toContain("layout.replace");

    // Composed from the projection: structurally identical to appStore's tree.
    const store = useAppStore.getState().rootPanel;
    expect(latest).not.toBeNull();
    expect(toMinimalNode(latest!)).toEqual(toMinimalNode(store));

    const split = latest as Extract<PanelNode, { type: "split" }>;
    const leafA = split.children[0] as LeafPanel;
    // Rich content re-hydrated by id.
    expect(leafA.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(leafA.tabs[0].title).toBe("Tab t1");
    expect(leafA.tabs[0].sessionId).toBe("sess-t1");
  });

  it("flag on but region never catches up: falls back to the appStore tree", async () => {
    setLayoutRenderFromProjectionEnabled(true);
    backend.applyReplace = false; // region stays on the initial single-leaf snapshot
    await mount();

    // Seed was attempted, but the region did not advance to a mirror.
    expect(dispatched.map((d) => d.kind)).toContain("layout.replace");
    // Renderer fell back to appStore's tree rather than showing the stale leaf.
    expect(latest).toBe(useAppStore.getState().rootPanel);
  });
});
