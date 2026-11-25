import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_RUN_TARGET_CHOICE,
  initialRunTargetChoice,
  rememberRunTargetChoice,
  rememberedRunTargetChoice,
  resetRememberedRunTargetChoice,
  resolveRunTargetChoice,
  type RunTargetOptions,
} from "./runTargetChoice";

const options = (over: Partial<RunTargetOptions> = {}): RunTargetOptions => ({
  active: { id: "a", title: "web-1", live: true },
  terminals: [
    { id: "a", title: "web-1", live: true, where: "", group: "" },
    { id: "b", title: "web-2", live: true, where: "", group: "" },
    { id: "c", title: "db-1", live: false, where: "", group: "" },
  ],
  broadcast: ["a", "b"],
  panel: ["a"],
  all: ["a", "b"],
  groupName: "web",
  groups: [{ id: "g1", name: "web", tabIds: ["b"] }],
  ...over,
});

describe("resolveRunTargetChoice (#5818 slice 5)", () => {
  it("resolves every kind to its live terminals", () => {
    const o = options();
    const r = (kind: Parameters<typeof resolveRunTargetChoice>[0]["kind"], extra = {}) =>
      resolveRunTargetChoice({ kind, parallel: true, ...extra }, o);
    expect(r("active")).toEqual(["a"]);
    expect(r("broadcast")).toEqual(["a", "b"]);
    expect(r("panel")).toEqual(["a"]);
    expect(r("all")).toEqual(["a", "b"]);
    expect(r("group", { groupId: "g1" })).toEqual(["b"]);
    expect(r("group", { groupId: "gone" })).toEqual([]);
    // A picked terminal that is not live is never a target; tab order wins.
    expect(r("pick", { picked: ["c", "b", "a"] })).toEqual(["a", "b"]);
  });

  it("reaches nothing when the active terminal is not live or broadcast is off", () => {
    const o = options({
      active: { id: "c", title: "db-1", live: false },
      broadcast: null,
    });
    expect(resolveRunTargetChoice({ kind: "active", parallel: true }, o)).toEqual([]);
    expect(resolveRunTargetChoice({ kind: "broadcast", parallel: true }, o)).toEqual([]);
  });
});

describe("initialRunTargetChoice (#5818 slice 5)", () => {
  it("opens on this terminal before any run", () => {
    expect(initialRunTargetChoice(null, options())).toEqual(DEFAULT_RUN_TARGET_CHOICE);
  });

  it("keeps a remembered choice that still applies", () => {
    const pick = { kind: "pick" as const, picked: ["b"], parallel: false };
    expect(initialRunTargetChoice(pick, options())).toEqual(pick);
    const group = { kind: "group" as const, groupId: "g1", parallel: true };
    expect(initialRunTargetChoice(group, options())).toEqual(group);
  });

  it("falls back to this terminal when the remembered option is gone, keeping parallel", () => {
    const fallback = { kind: "active", parallel: false };
    expect(
      initialRunTargetChoice({ kind: "broadcast", parallel: false }, options({ broadcast: null }))
    ).toEqual(fallback);
    expect(
      initialRunTargetChoice({ kind: "group", groupId: "gone", parallel: false }, options())
    ).toEqual(fallback);
    expect(
      initialRunTargetChoice({ kind: "panel", parallel: false }, options({ active: null }))
    ).toEqual(fallback);
  });
});

describe("remembered run target choice", () => {
  beforeEach(() => resetRememberedRunTargetChoice());

  it("remembers a copy of the last choice", () => {
    const picked = ["a"];
    rememberRunTargetChoice({ kind: "pick", picked, parallel: true });
    picked.push("b");
    expect(rememberedRunTargetChoice()).toEqual({ kind: "pick", picked: ["a"], parallel: true });
  });
});
