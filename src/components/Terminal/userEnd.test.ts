import { describe, expect, it } from "vitest";
import { ensureSessionSubscribed } from "@/store/sessionBridge";
import {
  connected,
  disconnected,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import { sessionEndedByUser } from "./userEnd";

const harness = installSessionLifecycleHarness();

describe("sessionEndedByUser (#5959)", () => {
  it("is true once the backend folded the tab's user end", async () => {
    ensureSessionSubscribed();
    harness.transport.setSession("tab-user", disconnected("user"));
    harness.transport.setSession("tab-lost", disconnected("unexpected"));
    harness.transport.setSession("tab-live", connected());
    await flushSessionRegion();

    expect(sessionEndedByUser("tab-user")).toBe(true);
    expect(sessionEndedByUser("tab-lost")).toBe(false);
    expect(sessionEndedByUser("tab-live")).toBe(false);
    expect(sessionEndedByUser("tab-unknown")).toBe(false);
  });
});
