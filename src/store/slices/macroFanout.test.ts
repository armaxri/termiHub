import { describe, it, expect } from "vitest";
import { createMacroFanoutInjector, describeMacroFanoutOutcome } from "./macroFanout";

describe("createMacroFanoutInjector (PROD-042)", () => {
  it("delivers each step to every live target", async () => {
    const seen: string[] = [];
    const fan = createMacroFanoutInjector(
      ["a", "b"],
      async (id, data) => {
        seen.push(`${id}:${data}`);
        return true;
      },
      (ids) => ids
    );
    expect(await fan.inject("x")).toBe(true);
    expect(seen).toEqual(["a:x", "b:x"]);
    expect(fan.live()).toEqual(["a", "b"]);
  });

  it("drops a target that is no longer connected before injecting into it", async () => {
    const seen: string[] = [];
    let connected = ["a", "b"];
    const fan = createMacroFanoutInjector(
      ["a", "b"],
      async (id, data) => {
        seen.push(`${id}:${data}`);
        return true;
      },
      (ids) => ids.filter((id) => connected.includes(id))
    );
    await fan.inject("1");
    connected = ["a"];
    await fan.inject("2");
    expect(seen).toEqual(["a:1", "b:1", "a:2"]);
    expect(fan.dropped()).toEqual(["b"]);
  });

  it("treats a rejected injection as a failed target", async () => {
    const fan = createMacroFanoutInjector(
      ["a", "b"],
      async (id) => {
        if (id === "b") throw new Error("gone");
        return true;
      },
      (ids) => ids
    );
    expect(await fan.inject("x")).toBe(true);
    expect(fan.live()).toEqual(["a"]);
    expect(fan.dropped()).toEqual(["b"]);
  });

  it("returns false once every target is gone or no injector exists", async () => {
    const none = createMacroFanoutInjector(["a"], null, (ids) => ids);
    expect(await none.inject("x")).toBe(false);
    const allGone = createMacroFanoutInjector(
      ["a"],
      async () => true,
      () => []
    );
    expect(await allGone.inject("x")).toBe(false);
  });
});

describe("describeMacroFanoutOutcome (PROD-042)", () => {
  const base = {
    requested: 3,
    delivered: 3,
    dropped: 0,
    skipped: 0,
    stepsPlayed: 4,
    totalSteps: 4,
  };

  it("is a success only when every requested terminal got the whole macro", () => {
    expect(describeMacroFanoutOutcome("M", { ...base, status: "completed" })).toEqual({
      kind: "success",
      message: 'Played macro "M" on 3 terminals',
    });
  });

  it("reports skipped and dropped targets as an error", () => {
    const s = describeMacroFanoutOutcome("M", {
      ...base,
      status: "completed",
      delivered: 1,
      dropped: 1,
      skipped: 1,
    });
    expect(s.kind).toBe("error");
    expect(s.message).toBe('Played macro "M" on 1 of 3 terminals');
    expect(s.description).toBe(
      "1 skipped (not connected) · 1 stopped early (disconnected mid-playback)"
    );
  });

  it("summarises a cancelled run with the steps played", () => {
    const s = describeMacroFanoutOutcome("M", {
      ...base,
      status: "cancelled",
      delivered: 2,
      stepsPlayed: 1,
      skipped: 1,
    });
    expect(s.kind).toBe("info");
    expect(s.description).toBe(
      "Stopped after 1 of 4 steps on 2 terminals · 1 skipped (not connected)"
    );
  });

  it("reports an errored run when no target is left", () => {
    const s = describeMacroFanoutOutcome("M", {
      ...base,
      status: "error",
      delivered: 0,
      dropped: 3,
    });
    expect(s.kind).toBe("error");
    expect(s.message).toContain("no target terminal is still connected");
  });
});
