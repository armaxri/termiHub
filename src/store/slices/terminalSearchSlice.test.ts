import { describe, it, expect, beforeEach } from "vitest";
import { create, type StateCreator } from "zustand";

import { createTerminalSearchSlice, type TerminalSearchSlice } from "./terminalSearchSlice";

// Runtime-only per-tab search-bar visibility; pure reducers, no `@/services`.
const makeStore = () =>
  create<TerminalSearchSlice>()(
    createTerminalSearchSlice as unknown as StateCreator<TerminalSearchSlice>
  );

describe("terminalSearchSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it("starts with no visible search bars", () => {
    expect(store.getState().terminalSearchVisible).toEqual({});
  });

  it("sets visibility per tab without disturbing other tabs", () => {
    store.getState().setTerminalSearchVisible("tab-a", true);
    store.getState().setTerminalSearchVisible("tab-b", false);
    expect(store.getState().terminalSearchVisible).toEqual({ "tab-a": true, "tab-b": false });
    store.getState().setTerminalSearchVisible("tab-a", false);
    expect(store.getState().terminalSearchVisible).toEqual({ "tab-a": false, "tab-b": false });
  });

  it("toggle flips an existing tab and treats a missing tab as hidden→visible", () => {
    // Undefined (never set) is falsy, so the first toggle turns it on.
    store.getState().toggleTerminalSearch("tab-x");
    expect(store.getState().terminalSearchVisible["tab-x"]).toBe(true);
    store.getState().toggleTerminalSearch("tab-x");
    expect(store.getState().terminalSearchVisible["tab-x"]).toBe(false);
  });
});
