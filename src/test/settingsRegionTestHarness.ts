/**
 * Test harness for the authoritative `settings` projection region (#2227).
 *
 * The Settings domain reads the persisted `AppSettings` document from the shared
 * `settings` region ({@link import("@/store/useProjectedSettings").useProjectedSettings}),
 * which is now the source of truth — tests can no longer seed settings into
 * `appStore` and expect the UI to reflect them; they seed the **region**.
 *
 * {@link FakeSettingsTransport} is an in-memory twin of the Rust `SettingsStore`:
 * it holds one opaque settings document, folds the `settings.*` intents **exactly
 * as the backend routes them** (see `settings_projection/projection.rs`) —
 * `settings.replace` ← `{ settings }`, `settings.patch` ← `{ patch }`,
 * `settings.reset` ← `{}` — and fans a fresh snapshot to every subscriber.
 * {@link FakeSettingsTransport.seed} pre-populates the document for a test's
 * initial render; {@link FakeSettingsTransport.dispatched} records dispatched
 * intents for assertions.
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
  __emitSettingsViewForTest,
  currentSettingsView,
  DEFAULT_SETTINGS_VIEW,
  SETTINGS_REGION,
  setSettingsTransportForTest,
  stopSettingsSubscription,
} from "@/store/settingsBridge";
import type { AppSettings } from "@/types/connection";

/** Build an `AppSettings` document with sensible required-field defaults. */
export function settingsDoc(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    version: "1",
    externalConnectionFiles: [],
    powerMonitoringEnabled: true,
    fileBrowserEnabled: true,
    ...overrides,
  };
}

/**
 * An in-memory substrate double for the `settings` region: holds one opaque
 * document, folds the `settings.*` intents like the Rust `SettingsStore`, and fans
 * a snapshot to every subscriber. Faithful to the backend's payload envelopes so a
 * client-dispatched intent round-trips back into the projected document exactly as
 * it would in production.
 */
export class FakeSettingsTransport implements Transport {
  dispatched: Intent[] = [];
  private view: Record<string, unknown> = { ...DEFAULT_SETTINGS_VIEW };
  private version = 0;
  private handlers = new Set<FrameHandler>();

  /**
   * When `true`, a folded `settings.*` dispatch is also reflected synchronously
   * into the bridge's projected view via {@link __emitSettingsViewForTest} — the
   * stand-in for the production server-side fold, so a UI-driven mutation (an
   * `updateSettings` / `updateShellIntegration` from a command wrapper) updates
   * every reader without waiting for a subscribe round-trip. The
   * {@link setupSettingsRegion} path enables this; the lower-level
   * {@link installSettingsHarness} leaves it off so bridge-level tests observe the
   * raw transport without an implicit view commit.
   */
  constructor(private readonly reflectDispatch = false) {}

  /** Seed the region document directly (test setup), fanning a snapshot. */
  seed(view: AppSettings): void {
    this.view = structuredClone(view) as unknown as Record<string, unknown>;
    this.bump();
  }

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** The current projected document (assertion helper). */
  regionView(): AppSettings {
    return structuredClone(this.view) as unknown as AppSettings;
  }

  /** The current monotonic region version (mirrors the Rust store's version). */
  currentVersion(): number {
    return this.version;
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const p = intent.payload as Record<string, unknown>;
    switch (intent.kind) {
      case "settings.replace":
        this.view = (p.settings ?? {}) as Record<string, unknown>;
        break;
      case "settings.patch": {
        const patch = (p.patch ?? {}) as Record<string, unknown>;
        this.view = { ...this.view, ...patch };
        break;
      }
      case "settings.reset":
        this.view = { ...DEFAULT_SETTINGS_VIEW };
        break;
      default:
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    if (this.reflectDispatch) {
      __emitSettingsViewForTest(this.regionView(), this.version);
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: SETTINGS_REGION, version: this.version }],
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
    const frame = this.snapshot(SETTINGS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeSettingsTransport} as the settings bridge's transport and
 * optionally seed it with the initial document. Returns the transport plus a
 * `teardown` that drops the subscription and restores the real transport — call it
 * in `afterEach`.
 */
export function installSettingsHarness(
  initial?: AppSettings,
  opts?: { reflectDispatch?: boolean }
): {
  transport: FakeSettingsTransport;
  teardown: () => void;
} {
  const transport = new FakeSettingsTransport(opts?.reflectDispatch ?? false);
  setSettingsTransportForTest(transport);
  if (initial) transport.seed(initial);
  return {
    transport,
    teardown: () => {
      stopSettingsSubscription();
      setSettingsTransportForTest(null);
    },
  };
}

// ── Region-direct seeding (the post-reducer-removal idiom, #2404) ──────────────

let activeHarness: { transport: FakeSettingsTransport; teardown: () => void } | undefined;

/**
 * Seed (or extend) the authoritative `settings` region for the current test —
 * the replacement for the retired `useAppStore.setState({ settings })` idiom now
 * that `appStore` holds no settings slice (#2404). **Merges** the partial into the
 * currently-projected document (starting from {@link DEFAULT_SETTINGS_VIEW} each
 * test), mirroring how the old shallow `setState({ settings: { ...current, … } })`
 * spread worked — so a test can set only the fields it cares about. Both seeds the
 * transport (so a hook subscribing later gets a correct snapshot) and synchronously
 * emits the view (so a reader mounting / re-rendering now reflects it without the
 * async subscribe round-trip).
 */
export function seedSettings(partial: Partial<AppSettings>): void {
  if (!activeHarness) {
    throw new Error("seedSettings() requires setupSettingsRegion() at module scope");
  }
  const next = { ...currentSettingsView(), ...partial } as AppSettings;
  activeHarness.transport.seed(next);
  __emitSettingsViewForTest(next, activeHarness.transport.currentVersion());
}

/** The transport double backing the active region seed (assertion helper). */
export function settingsHarnessTransport(): FakeSettingsTransport {
  if (!activeHarness) {
    throw new Error("settingsHarnessTransport() requires setupSettingsRegion() at module scope");
  }
  return activeHarness.transport;
}

/**
 * Register a `beforeEach` / `afterEach` pair that installs the region transport
 * double (seeded to {@link DEFAULT_SETTINGS_VIEW}, or `initial` if given) for every
 * test in the current module. Call once at module scope, then use
 * {@link seedSettings} inside individual tests to populate the region. Supersedes
 * the render-cut-era `setupSettingsRegionMirror`, which mirrored `appStore.settings`
 * into the region — a bridge that no longer exists now that `appStore` holds no
 * settings slice (#2404).
 */
export function setupSettingsRegion(initial?: AppSettings): void {
  beforeEach(() => {
    activeHarness = installSettingsHarness(initial ?? DEFAULT_SETTINGS_VIEW, {
      reflectDispatch: true,
    });
    // Synchronously prime the projected view so a reader that renders before the
    // hook's async subscribe resolves still sees the seeded baseline.
    __emitSettingsViewForTest(
      initial ?? DEFAULT_SETTINGS_VIEW,
      activeHarness.transport.currentVersion()
    );
  });
  afterEach(() => {
    activeHarness?.teardown();
    activeHarness = undefined;
  });
}
