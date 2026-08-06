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
import {
  DEFAULT_SETTINGS_VIEW,
  SETTINGS_REGION,
  setSettingsTransportForTest,
  stopSettingsSubscription,
  type SettingsView,
} from "@/store/settingsBridge";
import type { AppSettings } from "@/types/connection";

/** Build an `AppSettings` document with sensible required-field defaults. */
export function settingsDoc(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    version: "1",
    externalConnectionFiles: [],
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
    this.view = structuredClone(view) as Record<string, unknown>;
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

/** Convenience: a `SettingsView` (== `AppSettings`) for seeding. */
export function settingsRegionView(overrides: Partial<AppSettings> = {}): SettingsView {
  return settingsDoc(overrides);
}
