import { describe, it, expect } from "vitest";
import { deriveTabStatus, type TabStatusMaps } from "./tabStatus";

/** Build a maps object with all lifecycle records empty, then override selectively. */
function makeMaps(overrides: Partial<TabStatusMaps> = {}): TabStatusMaps {
  return {
    terminalConnecting: {},
    terminalReconnectingTabs: {},
    terminalSpawnErrors: {},
    terminalDisconnectErrors: {},
    terminalExitedTabs: {},
    ...overrides,
  };
}

describe("deriveTabStatus", () => {
  it("returns 'connecting' while a terminal is spawning", () => {
    const maps = makeMaps({ terminalConnecting: { a: true } });
    expect(deriveTabStatus(maps, "a")).toBe("connecting");
  });

  it("returns 'connecting' while a terminal is reconnecting", () => {
    const maps = makeMaps({ terminalReconnectingTabs: { a: true } });
    expect(deriveTabStatus(maps, "a")).toBe("connecting");
  });

  it("returns 'failed' when the terminal has a spawn error", () => {
    const maps = makeMaps({ terminalSpawnErrors: { a: "boom" } });
    expect(deriveTabStatus(maps, "a")).toBe("failed");
  });

  it("returns 'failed' when the terminal has a disconnect error", () => {
    const maps = makeMaps({ terminalDisconnectErrors: { a: "dropped" } });
    expect(deriveTabStatus(maps, "a")).toBe("failed");
  });

  it("returns 'disconnected' when the terminal session has exited without an error", () => {
    const maps = makeMaps({ terminalExitedTabs: { a: true } });
    expect(deriveTabStatus(maps, "a")).toBe("disconnected");
  });

  it("returns 'disconnected' when the live agent session is lost (#2524)", () => {
    // #2512 session-lost: the transport came back but the live session could not
    // be recovered. The dot must never stay green — regression for #2524 bug 2.
    const maps = makeMaps({ terminalSessionLost: { a: true } });
    expect(deriveTabStatus(maps, "a")).toBe("disconnected");
  });

  it("treats session-lost as terminal — it wins over an in-flight connecting flag (#2524)", () => {
    // The region can report `sessionLost` while a stale connecting flag lingers
    // (settleSessionLost has not folded yet). Session-lost is terminal, so the
    // dot must show disconnected rather than a green-adjacent connecting pulse.
    const maps = makeMaps({
      terminalSessionLost: { a: true },
      terminalConnecting: { a: true },
    });
    expect(deriveTabStatus(maps, "a")).toBe("disconnected");
  });

  it("returns 'connected' when no lifecycle flags are set", () => {
    const maps = makeMaps();
    expect(deriveTabStatus(maps, "a")).toBe("connected");
  });

  it("prioritises 'connecting' over other flags (retry/reconnect in-flight)", () => {
    const maps = makeMaps({
      terminalConnecting: { a: true },
      terminalExitedTabs: { a: true },
      terminalSpawnErrors: { a: "boom" },
    });
    expect(deriveTabStatus(maps, "a")).toBe("connecting");
  });

  it("prioritises 'failed' over a bare 'disconnected' flag", () => {
    const maps = makeMaps({
      terminalExitedTabs: { a: true },
      terminalDisconnectErrors: { a: "dropped" },
    });
    expect(deriveTabStatus(maps, "a")).toBe("failed");
  });

  it("keys strictly by tab id — an unrelated tab's flags do not leak", () => {
    const maps = makeMaps({ terminalConnecting: { other: true } });
    expect(deriveTabStatus(maps, "a")).toBe("connected");
  });
});
