/**
 * appStore ↔ layout projection bridge wiring (#2151 step 2).
 *
 * Drives the `splitPanel` mutation through a simulated backend (a fake transport
 * that applies the `layout.*` intent with the same panel-tree algebra the Rust
 * store uses, then pushes the diff to the region client) and asserts the
 * reconciled tree lands in `appStore.rootPanel` with the rich tabs preserved.
 * Also pins the strangler guarantees: flag-off keeps the local reducer, and a
 * rejected intent falls back to it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import type { PanelNode } from "@/types/terminal";
import {
  createLeafPanel,
  getAllLeaves,
  findLeaf,
  simplifyTree,
  splitLeaf,
} from "@/utils/panelTree";

interface RegionState {
  version: number;
  view: unknown;
}

const { backend, dispatched } = vi.hoisted(() => ({
  backend: {
    version: -1,
    view: undefined as unknown,
    listeners: new Set<(s: RegionState) => void>(),
    reject: false,
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
      this.reject = false;
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
      if (backend.reject) {
        return { intentId: "intent-test", status: "rejected", error: { code: "x", message: "nope" } };
      }
      if (intent.kind === "layout.replace") {
        backend.push({ root: intent.payload.root, activePanelId: intent.payload.activePanelId });
      } else if (intent.kind === "layout.split") {
        const view = backend.view as { root: PanelNode };
        const newLeaf = createLeafPanel();
        let root = splitLeaf(
          view.root,
          intent.payload.panelId as string,
          newLeaf,
          intent.payload.direction as "horizontal" | "vertical",
          intent.payload.position as "before" | "after"
        );
        root = simplifyTree(root);
        backend.push({ root, activePanelId: newLeaf.id });
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
      backend.push({ root: createLeafPanel(), activePanelId: null });
    }
    stop() {}
  },
}));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

import { useAppStore } from "./appStore";
import { setLayoutIntentsEnabled } from "./layoutBridge";
import type { TerminalTab } from "@/types/terminal";

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
    children: [
      { type: "leaf", id: "a", tabs: [tab("t1"), tab("t2")], activeTabId: "t1" },
      { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
    ],
  };
}

async function flush() {
  // Let the fire-and-forget bridge promise chain settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("appStore layout bridge — splitPanel cut (#2151)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ rootPanel: seedTree(), activePanelId: "a" });
    backend.reset();
    dispatched.length = 0;
    setLayoutIntentsEnabled(null);
  });

  it("flag off: splitPanel mutates locally and dispatches nothing", () => {
    setLayoutIntentsEnabled(false);
    useAppStore.getState().splitPanel("vertical");

    expect(dispatched).toHaveLength(0);
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
  });

  it("flag on: splitPanel seeds then dispatches layout.split and reconciles the diff", async () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().splitPanel("vertical");
    await flush();

    // Seed-before-mutate: replace precedes the structural intent.
    expect(dispatched.map((d) => d.kind)).toEqual(["layout.replace", "layout.split"]);
    expect(dispatched[1].payload).toMatchObject({
      panelId: "a",
      direction: "vertical",
      position: "after",
    });

    const root = useAppStore.getState().rootPanel;
    const leaves = getAllLeaves(root);
    expect(leaves).toHaveLength(3);
    // The new empty leaf is focused.
    const active = findLeaf(root, useAppStore.getState().activePanelId!);
    expect(active?.tabs).toHaveLength(0);
    // Existing rich tabs survived the round-trip (re-hydrated by id).
    const a = findLeaf(root, "a")!;
    expect(a.tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(a.tabs[0].title).toBe("Tab t1");
    expect(a.tabs[0].sessionId).toBe("sess-t1");
  });

  it("flag on but intent rejected: falls back to the local reducer", async () => {
    setLayoutIntentsEnabled(true);
    backend.reject = true;
    useAppStore.getState().splitPanel("vertical");
    await flush();

    // Still ended up split — via the local fallback path.
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
  });
});
