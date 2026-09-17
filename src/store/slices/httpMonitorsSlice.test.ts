import { describe, it, expect, beforeEach } from "vitest";
import { create, type StateCreator } from "zustand";

import type { HttpMonitorState } from "@/types/network";

import { createHttpMonitorsSlice, type HttpMonitorsSlice } from "./httpMonitorsSlice";

// Single replace-all setter for the Network Tools sidebar's live monitor list;
// pure reducer, no `@/services`.
const makeStore = () =>
  create<HttpMonitorsSlice>()(
    createHttpMonitorsSlice as unknown as StateCreator<HttpMonitorsSlice>
  );

const monitor = (id: string): HttpMonitorState => ({
  config: {
    id,
    url: `https://${id}.example`,
    intervalMs: 5000,
    method: "GET",
    expectedStatus: 200,
    timeoutMs: 3000,
  },
  running: true,
  paused: false,
});

describe("httpMonitorsSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it("starts with an empty monitor list", () => {
    expect(store.getState().httpMonitors).toEqual([]);
  });

  it("replaces the full monitor list", () => {
    const list = [monitor("a"), monitor("b")];
    store.getState().setHttpMonitors(list);
    expect(store.getState().httpMonitors).toBe(list);
    // A subsequent set fully replaces (not merges) the previous list.
    store.getState().setHttpMonitors([]);
    expect(store.getState().httpMonitors).toEqual([]);
  });
});
