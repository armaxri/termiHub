import { describe, it, expect, afterEach } from "vitest";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  currentPluginSandboxView,
  EMPTY_SANDBOX_VIEW,
  ensurePluginSandboxSubscribed,
  onPluginSandboxView,
  PLUGIN_SANDBOX_REGION,
  setPluginSandboxTransportForTest,
  type PluginSandboxView,
} from "./pluginSandboxBridge";

/** A transport that serves one fixed `plugin-sandbox` snapshot. */
class FixedTransport implements Transport {
  subscribed: string[] = [];
  constructor(private readonly view: unknown) {}
  async dispatch(intent: Intent): Promise<IntentAck> {
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }
  async subscribe(region: string, _onFrame: FrameHandler): Promise<Subscription> {
    this.subscribed.push(region);
    return {
      snapshot: { kind: "snapshot", region, version: 3, view: this.view } as SnapshotFrame,
      unsubscribe: () => {},
    };
  }
  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }
}

describe("pluginSandboxBridge (#4188)", () => {
  afterEach(() => setPluginSandboxTransportForTest(null));

  it("subscribes to the plugin-sandbox region and fans the view out", async () => {
    const view: PluginSandboxView = {
      outOfProcess: true,
      plugins: {
        acme: { isolation: "reduced", enforced: ["seccomp"], missing: ["landlock"], denials: [] },
      },
    };
    const transport = new FixedTransport(view);
    setPluginSandboxTransportForTest(transport);
    const seen: PluginSandboxView[] = [];
    const off = onPluginSandboxView((v) => seen.push(v));
    await ensurePluginSandboxSubscribed();
    off();
    expect(transport.subscribed).toEqual([PLUGIN_SANDBOX_REGION]);
    expect(currentPluginSandboxView()).toEqual(view);
    expect(seen[seen.length - 1]).toEqual(view);
  });

  it("normalises a missing view to the empty one", async () => {
    setPluginSandboxTransportForTest(new FixedTransport(null));
    expect(currentPluginSandboxView()).toBe(EMPTY_SANDBOX_VIEW);
    await ensurePluginSandboxSubscribed();
    expect(currentPluginSandboxView()).toEqual({ outOfProcess: false, plugins: {} });
  });
});
