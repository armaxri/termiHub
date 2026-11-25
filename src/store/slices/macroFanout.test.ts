import { describe, it, expect } from "vitest";
import { createTargetInjector, describeMacroFanoutOutcome, tallyMacroTargets } from "./macroFanout";

describe("createTargetInjector (#5818 slice 5)", () => {
  it("types into a target only while it is still connected", async () => {
    const seen: string[] = [];
    let connected = ["a", "b"];
    const inject = createTargetInjector(
      async (id, data) => {
        seen.push(`${id}:${data}`);
        return true;
      },
      (id) => connected.includes(id)
    );
    expect(await inject("a", "1")).toBe(true);
    expect(await inject("b", "1")).toBe(true);
    connected = ["a"];
    expect(await inject("b", "2")).toBe(false);
    expect(seen).toEqual(["a:1", "b:1"]);
  });

  it("treats a rejected injection or a missing injector as stopped input", async () => {
    const throwing = createTargetInjector(
      async () => {
        throw new Error("gone");
      },
      () => true
    );
    expect(await throwing("a", "x")).toBe(false);
    expect(await createTargetInjector(null, () => true)("a", "x")).toBe(false);
  });
});

describe("tallyMacroTargets (#5818 slice 5)", () => {
  const done = (tabId: string, stepsPlayed = 2) => ({
    tabId,
    status: "completed" as const,
    stepsPlayed,
  });

  it("completes when every target typed the whole macro", () => {
    expect(tallyMacroTargets([done("a"), done("b")])).toEqual({
      status: "completed",
      delivered: 2,
      dropped: 0,
      stepsPlayed: 2,
    });
  });

  it("stays completed when one target dropped and others finished", () => {
    const t = tallyMacroTargets([done("a"), { tabId: "b", status: "error", stepsPlayed: 1 }]);
    expect(t).toMatchObject({ status: "completed", delivered: 1, dropped: 1 });
  });

  it("is an error only when every target dropped", () => {
    const t = tallyMacroTargets([
      { tabId: "a", status: "error", stepsPlayed: 0 },
      { tabId: "b", status: "error", stepsPlayed: 1 },
    ]);
    expect(t).toMatchObject({ status: "error", delivered: 0, dropped: 2, stepsPlayed: 1 });
  });

  it("is canceled when a target was stopped or never started", () => {
    expect(
      tallyMacroTargets([done("a"), { tabId: "b", status: "cancelled", stepsPlayed: 1 }]).status
    ).toBe("cancelled");
    expect(
      tallyMacroTargets([done("a"), { tabId: "b", status: undefined, stepsPlayed: 0 }]).status
    ).toBe("cancelled");
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
      message: 'Ran automation "M" on 3 terminals',
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
    expect(s.message).toBe('Ran automation "M" on 1 of 3 terminals');
    expect(s.description).toBe(
      "1 skipped (not connected) · 1 stopped early (disconnected mid-playback)"
    );
  });

  it("says how many terminals a stopped run finished on", () => {
    const s = describeMacroFanoutOutcome("M", {
      ...base,
      status: "cancelled",
      delivered: 2,
      stepsPlayed: 1,
      skipped: 1,
    });
    expect(s.kind).toBe("info");
    expect(s.description).toBe("Finished on 2 of 3 terminals · 1 skipped (not connected)");
  });

  it("never hides a dropped terminal behind a stopped run", () => {
    const s = describeMacroFanoutOutcome("M", {
      ...base,
      status: "cancelled",
      delivered: 0,
      dropped: 1,
    });
    expect(s.kind).toBe("error");
    expect(s.description).toContain("1 stopped early (disconnected mid-playback)");
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
