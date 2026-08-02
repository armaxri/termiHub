/**
 * `useProjectedTransfers` — reads the authoritative `transfers` projection region
 * (#2229). Drives the hook against the in-memory {@link FakeTransferTransport} and
 * asserts: it returns the seeded region view, re-renders on a region diff, and
 * reflects a client-dispatched intent that round-trips through the store twin.
 * There is no appStore fallback and no mirror gate — the region is the source of
 * truth.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type TransfersView } from "./transfersBridge";
import { useProjectedTransfers } from "./useProjectedTransfers";
import {
  fakeTransferEntry,
  installTransferHarness,
  transfersView,
  type FakeTransferTransport,
} from "@/test/transferHarness";

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

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => TransfersView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: TransfersView = { queue: {}, minimized: false };

  function Probe() {
    latest = useProjectedTransfers();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransferTransport;
let teardown: () => void;

beforeEach(() => {
  ({ transport, teardown } = installTransferHarness());
});

afterEach(() => {
  teardown();
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedTransfers", () => {
  it("returns the seeded region view", async () => {
    const view = transfersView([
      fakeTransferEntry("t1"),
      fakeTransferEntry("t2", { state: "queued" }),
    ]);
    transport.seed(view);

    const hook = renderHook();
    await flush();
    await flush();

    expect(hook.get().queue).toEqual(view.queue);
    expect(hook.get().minimized).toBe(false);
    hook.unmount();
  });

  it("re-renders on a region diff (a dispatched intent round-trips)", async () => {
    transport.seed(transfersView([fakeTransferEntry("t1")]));
    const hook = renderHook();
    await flush();
    await flush();
    expect(Object.keys(hook.get().queue)).toEqual(["t1"]);

    // A collapse intent advances the shared region; the hook reflects it.
    await act(async () => {
      await transport.dispatch({
        intentId: "i1",
        kind: "transfer.setMinimized",
        payload: { minimized: true },
        clientId: "c1",
      });
    });
    await flush();

    expect(hook.get().minimized).toBe(true);
    hook.unmount();
  });

  it("starts from the empty view when the region is empty", async () => {
    const hook = renderHook();
    await flush();

    expect(hook.get()).toEqual({ queue: {}, minimized: false });
    hook.unmount();
  });
});
