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

import { useAppStore } from "@/store/appStore";
import {
  __emitSettingsViewForTest,
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
export function installSettingsHarness(initial?: AppSettings): {
  transport: FakeSettingsTransport;
  teardown: () => void;
} {
  const transport = new FakeSettingsTransport();
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

/**
 * Install a {@link FakeSettingsTransport} that **mirrors `appStore.settings` into
 * the region**, for the many render-reader tests that drive settings through
 * `appStore` (`useAppStore.setState({ settings })`, or an action that mutates the
 * slice) and assert on the settings-driven UI.
 *
 * Now that {@link import("@/store/useProjectedSettings").useProjectedSettings}
 * reads the region authoritatively, those tests can no longer rely on the removed
 * `appStore` fallback — the UI renders what the region projects. This helper seeds
 * the region with the current document and re-seeds it on every `appStore.settings`
 * change, so the region tracks whatever the test puts in `appStore` — the test-side
 * analog of production, where the region is fed from the persisted document at the
 * source (#2386). Returns the transport plus a `teardown` (drops the appStore
 * subscription, the region subscription, and restores the real transport) — call it
 * in `afterEach`.
 */
export function installSettingsHarnessMirroringAppStore(): {
  transport: FakeSettingsTransport;
  teardown: () => void;
} {
  const { transport, teardown } = installSettingsHarness();
  // Seed the transport (so the hook's eventual subscribe snapshot is correct) AND
  // synchronously emit the view (so a reader mounting/re-rendering now reflects it
  // without waiting for the subscribe round-trip).
  const push = (settings: AppSettings): void => {
    transport.seed(settings);
    __emitSettingsViewForTest(settings, transport.currentVersion());
  };
  push(useAppStore.getState().settings);
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (state.settings !== prev.settings) push(state.settings);
  });
  return {
    transport,
    teardown: () => {
      unsubscribe();
      teardown();
    },
  };
}

/**
 * Register the appStore→region mirror ({@link installSettingsHarnessMirroringAppStore})
 * for a whole test file via self-managed `beforeEach`/`afterEach` hooks. Call once
 * at the top of a render-reader test's module (or describe) so its existing
 * `appStore`-driven settings setup keeps rendering correctly now that
 * {@link import("@/store/useProjectedSettings").useProjectedSettings} reads the
 * region authoritatively — no per-`beforeEach` wiring needed. The mirror's live
 * subscription re-seeds the region on every `appStore.settings` change during the
 * test, so a later `setState` or a settings-mutating action still reaches the UI.
 */
export function setupSettingsRegionMirror(): void {
  let harness: { transport: FakeSettingsTransport; teardown: () => void } | undefined;
  beforeEach(() => {
    harness = installSettingsHarnessMirroringAppStore();
  });
  afterEach(() => {
    harness?.teardown();
    harness = undefined;
  });
}
