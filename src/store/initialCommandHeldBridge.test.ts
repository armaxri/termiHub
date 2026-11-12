import { describe, it, expect, beforeEach } from "vitest";
import {
  clearInitialCommandHeld,
  dismissInitialCommandHeld,
  recordInitialCommandHeld,
  useInitialCommandHeldStore,
} from "./initialCommandHeldBridge";

const state = () => useInitialCommandHeldStore.getState().bySession;

describe("initialCommandHeldBridge (#5509)", () => {
  beforeEach(() => useInitialCommandHeldStore.setState({ bySession: {} }));

  it("records a held command and forgets it once it is no longer held", () => {
    recordInitialCommandHeld({ sessionId: "s1", held: true });
    expect(state()).toEqual({ s1: "held" });
    recordInitialCommandHeld({ sessionId: "s1", held: false });
    expect(state()).toEqual({});
  });

  it("a dismissed notice stays hidden until the backend clears it", () => {
    recordInitialCommandHeld({ sessionId: "s1", held: true });
    dismissInitialCommandHeld("s1");
    expect(state()).toEqual({ s1: "dismissed" });
    recordInitialCommandHeld({ sessionId: "s1", held: false });
    expect(state()).toEqual({});
  });

  it("dismissing or clearing an unknown session changes nothing", () => {
    const before = state();
    dismissInitialCommandHeld("nope");
    clearInitialCommandHeld("nope");
    expect(state()).toBe(before);
  });
});
