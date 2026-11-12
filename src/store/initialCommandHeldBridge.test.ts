import { describe, it, expect, beforeEach } from "vitest";
import {
  clearInitialCommandHeld,
  dismissInitialCommandHeld,
  recordInitialCommandHeld,
  useInitialCommandHeldStore,
} from "./initialCommandHeldBridge";

const state = () => useInitialCommandHeldStore.getState().bySession;
const event = (sessionId: string, held: boolean, setup = false) => ({
  sessionId,
  held,
  setup,
  initialCommand: true,
});
const notice = (state: "held" | "dismissed", setup = false) => ({
  state,
  setup,
  initialCommand: true,
});

describe("initialCommandHeldBridge (#5509, #5512)", () => {
  beforeEach(() => useInitialCommandHeldStore.setState({ bySession: {} }));

  it("records a held command and forgets it once it is no longer held", () => {
    recordInitialCommandHeld(event("s1", true));
    expect(state()).toEqual({ s1: notice("held") });
    recordInitialCommandHeld(event("s1", false));
    expect(state()).toEqual({});
  });

  it("a dismissed notice stays hidden until the backend clears it", () => {
    recordInitialCommandHeld(event("s1", true, true));
    dismissInitialCommandHeld("s1");
    expect(state()).toEqual({ s1: notice("dismissed", true) });
    recordInitialCommandHeld(event("s1", false));
    expect(state()).toEqual({});
  });

  it("dismissing or clearing an unknown session changes nothing", () => {
    const before = state();
    dismissInitialCommandHeld("nope");
    clearInitialCommandHeld("nope");
    expect(state()).toBe(before);
  });
});
