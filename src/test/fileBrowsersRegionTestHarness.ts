/**
 * Test harness for the authoritative `file-browser@<clientId>` projection region
 * (#2228 / #2283).
 *
 * Since the reducer removal (#2283) the file-browser *view* — the active pane, each
 * pane's cwd / listing / loading / error, and the copy-cut clipboard — no longer
 * lives in `appStore`; it is owned by the backend `FileBrowserStore` and projected
 * through the region ({@link import("@/store/useProjectedFileBrowsers").useProjectedFileBrowsers}).
 * Tests can no longer seed the view into `appStore` and expect the UI to reflect it;
 * they seed the **region**.
 *
 * {@link FakeFileBrowsersTransport} is an in-memory twin of the Rust
 * `FileBrowserStore`: it folds the granular `fileBrowser.*` intents exactly as the
 * backend routes them (mirroring `file_browser_projection/store.rs`) and fans a
 * fresh snapshot to every subscriber. {@link FakeFileBrowsersTransport.seed}
 * pre-populates the view for a test's initial render; {@link seedFileBrowsers} is
 * the region-direct seeding idiom that replaces the retired
 * `useAppStore.setState({ fileBrowserMode, localCurrentPath, … })`.
 */

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { afterEach, beforeEach } from "vitest";

import {
  __emitFileBrowsersViewForTest,
  currentFileBrowsersView,
  EMPTY_FILE_BROWSERS_VIEW,
  FILE_BROWSERS_REGION,
  setFileBrowsersTransportForTest,
  stopFileBrowsersSubscription,
  type FileBrowsersView,
} from "@/store/fileBrowsersBridge";
import type { FileClipboard } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";

/** Build a full {@link FileBrowsersView} from a partial (deep-merged per pane). */
export function fileBrowsersView(overrides: Partial<FileBrowsersView> = {}): FileBrowsersView {
  return {
    mode: overrides.mode ?? EMPTY_FILE_BROWSERS_VIEW.mode,
    local: { ...EMPTY_FILE_BROWSERS_VIEW.local, ...overrides.local },
    session: { ...EMPTY_FILE_BROWSERS_VIEW.session, ...overrides.session },
    clipboard: overrides.clipboard ?? null,
  };
}

/**
 * An in-memory substrate double for the `file-browser` region: holds one view,
 * folds the granular `fileBrowser.*` intents like the Rust `FileBrowserStore`, and
 * fans a snapshot to every subscriber. Faithful to the backend's payload envelopes
 * so a client-dispatched intent round-trips back into the projected view exactly as
 * it would in production.
 */
export class FakeFileBrowsersTransport implements Transport {
  dispatched: Intent[] = [];
  private view: FileBrowsersView = structuredClone(EMPTY_FILE_BROWSERS_VIEW);
  private version = 0;
  private handlers = new Set<FrameHandler>();

  /**
   * When `true`, a folded `fileBrowser.*` dispatch is also reflected synchronously
   * into the bridge's projected view via {@link __emitFileBrowsersViewForTest} — the
   * stand-in for the production server-side fold, so a UI-driven mutation updates
   * every reader without waiting for a subscribe round-trip. The
   * {@link setupFileBrowsersRegion} path enables this.
   */
  constructor(private readonly reflectDispatch = false) {}

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: FileBrowsersView): void {
    this.view = structuredClone(view);
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** The current projected view (assertion helper). */
  regionView(): FileBrowsersView {
    return structuredClone(this.view);
  }

  /** The current monotonic region version (mirrors the Rust store's version). */
  currentVersion(): number {
    return this.version;
  }

  private paneOf(name: unknown): "local" | "session" {
    return name === "session" ? "session" : "local";
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "fileBrowser.setMode":
        this.view.mode = (p.mode as FileBrowsersView["mode"]) ?? "none";
        break;
      case "fileBrowser.loadStarted": {
        const pane = this.view[this.paneOf(p.pane)];
        pane.loading = true;
        pane.error = null;
        break;
      }
      case "fileBrowser.loadSucceeded": {
        const pane = this.view[this.paneOf(p.pane)];
        pane.path = (p.path as string) ?? pane.path;
        pane.entries = structuredClone((p.entries as FileEntry[]) ?? []);
        pane.loading = false;
        pane.error = null;
        break;
      }
      case "fileBrowser.loadFailed": {
        const pane = this.view[this.paneOf(p.pane)];
        pane.loading = false;
        pane.error = (p.error as string | null) ?? null;
        break;
      }
      case "fileBrowser.setClipboard":
        this.view.clipboard = (p.clipboard as FileClipboard | null) ?? null;
        break;
      default:
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    if (this.reflectDispatch) {
      __emitFileBrowsersViewForTest(this.regionView(), this.version);
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: FILE_BROWSERS_REGION, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.add(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => this.handlers.delete(onFrame),
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private bump(): void {
    this.version += 1;
    const frame = this.snapshot(FILE_BROWSERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeFileBrowsersTransport} as the bridge's transport and
 * optionally seed it with the initial view. Returns the transport plus a `teardown`
 * that drops the subscription and restores the real transport — call it in
 * `afterEach`.
 */
export function installFileBrowsersHarness(
  initial?: FileBrowsersView,
  opts?: { reflectDispatch?: boolean }
): {
  transport: FakeFileBrowsersTransport;
  teardown: () => void;
} {
  const transport = new FakeFileBrowsersTransport(opts?.reflectDispatch ?? false);
  setFileBrowsersTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopFileBrowsersSubscription();
      setFileBrowsersTransportForTest(null);
    },
  };
}

// ── Region-direct seeding (the post-reducer-removal idiom, #2283) ──────────────

let activeHarness: { transport: FakeFileBrowsersTransport; teardown: () => void } | undefined;

/**
 * Seed (or extend) the authoritative `file-browser` region for the current test —
 * the replacement for the retired `useAppStore.setState({ fileBrowserMode, … })`
 * idiom now that `appStore` holds no file-browser view slice (#2283). **Merges**
 * the partial into the currently-projected view (starting from
 * {@link EMPTY_FILE_BROWSERS_VIEW} each test), so a test can set only the fields it
 * cares about. Both seeds the transport (so a hook subscribing later gets a correct
 * snapshot) and synchronously emits the view (so a reader mounting / re-rendering
 * now reflects it without the async subscribe round-trip).
 */
export function seedFileBrowsers(partial: Partial<FileBrowsersView>): void {
  if (!activeHarness) {
    throw new Error("seedFileBrowsers() requires setupFileBrowsersRegion() at module scope");
  }
  const current = currentFileBrowsersView();
  const next = fileBrowsersView({
    mode: partial.mode ?? current.mode,
    local: { ...current.local, ...partial.local },
    session: { ...current.session, ...partial.session },
    clipboard: partial.clipboard !== undefined ? partial.clipboard : current.clipboard,
  });
  activeHarness.transport.seed(next);
  __emitFileBrowsersViewForTest(next, activeHarness.transport.currentVersion());
}

/** The transport double backing the active region seed (assertion helper). */
export function fileBrowsersHarnessTransport(): FakeFileBrowsersTransport {
  if (!activeHarness) {
    throw new Error(
      "fileBrowsersHarnessTransport() requires setupFileBrowsersRegion() at module scope"
    );
  }
  return activeHarness.transport;
}

/**
 * Register a `beforeEach` / `afterEach` pair that installs the region transport
 * double (seeded to {@link EMPTY_FILE_BROWSERS_VIEW}, or `initial` if given) for
 * every test in the current module. Call once at module scope, then use
 * {@link seedFileBrowsers} inside individual tests to populate the region.
 */
export function setupFileBrowsersRegion(initial?: FileBrowsersView): void {
  beforeEach(() => {
    activeHarness = installFileBrowsersHarness(initial ?? EMPTY_FILE_BROWSERS_VIEW, {
      reflectDispatch: true,
    });
    // Synchronously prime the projected view so a reader that renders before the
    // hook's async subscribe resolves still sees the seeded baseline.
    __emitFileBrowsersViewForTest(
      initial ?? EMPTY_FILE_BROWSERS_VIEW,
      activeHarness.transport.currentVersion()
    );
  });
  afterEach(() => {
    activeHarness?.teardown();
    activeHarness = undefined;
  });
}
