/**
 * `useProjectedFileBrowsers` — the file-browser panel cut to the projected
 * client-scoped `file-browser@<clientId>` region (#2228 render cut). Drives the
 * hook against an in-memory substrate double and asserts: flag-off returns the
 * appStore slice and dispatches nothing; flag-on seeds the region (a
 * `fileBrowser.replace` mirror) and then renders the slice from the projection,
 * value-identical to appStore; and a region that has not caught up falls back to
 * the appStore slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import type { FileEntry } from "@/types/connection";

import {
  EMPTY_FILE_BROWSERS_VIEW,
  FILE_BROWSERS_REGION,
  setFileBrowsersRenderFromProjectionEnabled,
  setFileBrowsersTransportForTest,
  stopFileBrowsersSubscription,
  type FileBrowsersView,
} from "./fileBrowsersBridge";
import { useProjectedFileBrowsers } from "./useProjectedFileBrowsers";

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

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
    isSymlink: false,
    symlinkTarget: null,
  };
}

/** Seed appStore with a local-mode browsing state (the fields the hook reads). */
function seedAppStore(over: Record<string, unknown> = {}): void {
  useAppStore.setState({
    fileBrowserMode: "local",
    localFileEntries: [entry("a")],
    localCurrentPath: "/home",
    localFileLoading: false,
    localFileError: null,
    fileEntries: [],
    currentPath: "/",
    sftpStatus: "idle",
    sftpError: null,
    sessionFileEntries: [],
    sessionCurrentPath: "/",
    sessionFileLoading: false,
    sessionFileError: null,
    fileClipboard: null,
    ...over,
  });
}

/** In-memory substrate double: applies `fileBrowser.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `fileBrowser.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private stored: FileBrowsersView = { ...EMPTY_FILE_BROWSERS_VIEW };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "fileBrowser.replace" && this.applyReplace) {
      this.stored = intent.payload as unknown as FileBrowsersView;
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: FILE_BROWSERS_REGION, version: this.version }],
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
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.stored) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(FILE_BROWSERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => FileBrowsersView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: FileBrowsersView = { ...EMPTY_FILE_BROWSERS_VIEW };

  function Probe() {
    latest = useProjectedFileBrowsers();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setFileBrowsersTransportForTest(transport);
  seedAppStore();
});

afterEach(() => {
  stopFileBrowsersSubscription();
  setFileBrowsersTransportForTest(null);
  setFileBrowsersRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedFileBrowsers", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setFileBrowsersRenderFromProjectionEnabled(false);

    const hook = renderHook();
    await flush();

    expect(hook.get().mode).toBe("local");
    expect(hook.get().local.path).toBe("/home");
    expect(hook.get().local.entries).toEqual([entry("a")]);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's slice via fileBrowser.replace…
    expect(transport.dispatched.some((d) => d.kind === "fileBrowser.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    expect(hook.get().mode).toBe("local");
    expect(hook.get().local.path).toBe("/home");
    expect(hook.get().local.entries).toEqual([entry("a")]);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders the
    // appStore slice verbatim — parity preserved.
    expect(hook.get().mode).toBe("local");
    expect(hook.get().local.path).toBe("/home");
    expect(hook.get().local.entries).toEqual([entry("a")]);
    hook.unmount();
  });
});
