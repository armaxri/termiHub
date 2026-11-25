import { describe, it, expect } from "vitest";
import { hostChoice, sameHost, UNREADABLE_HOST } from "./hostChoice";
import { THIS_COMPUTER } from "@/types/tunnel";
import type { HostChoice } from "./hostChoice";

// The same cases as core's `util/service_host.rs`, so both sides read a stored
// host the same way (#6028).
describe("hostChoice", () => {
  it("reads an absent host and an explicit one as this computer", () => {
    expect(hostChoice(undefined)).toEqual(THIS_COMPUTER);
    expect(hostChoice({ kind: "thisComputer" })).toEqual(THIS_COMPUTER);
  });

  it("reads an agent by id", () => {
    expect(hostChoice({ kind: "agent", agentId: "a" })).toEqual({ kind: "agent", agentId: "a" });
  });

  it.each([
    null,
    true,
    "thisComputer",
    [],
    {},
    { kind: null },
    { kind: "agent" },
    { kind: "agent", agentId: "" },
    { kind: "agent", agentId: null },
    { kind: "agent", agentId: "a", container: "c" },
    { kind: "thisComputer", agentId: "a" },
    { kind: "thisComputer", jail: "/srv" },
    { kind: "ThisComputer" },
    { kind: "cluster" },
  ])("never reads %j as this computer", (raw) => {
    expect(hostChoice(raw)).toEqual(UNREADABLE_HOST);
  });

  it("compares hosts", () => {
    const agent = (agentId: string): HostChoice => ({ kind: "agent", agentId });
    expect(sameHost(THIS_COMPUTER, THIS_COMPUTER)).toBe(true);
    expect(sameHost(agent("a"), agent("a"))).toBe(true);
    expect(sameHost(agent("a"), agent("b"))).toBe(false);
    expect(sameHost(agent("a"), THIS_COMPUTER)).toBe(false);
    expect(sameHost(UNREADABLE_HOST, UNREADABLE_HOST)).toBe(true);
    expect(sameHost(UNREADABLE_HOST, THIS_COMPUTER)).toBe(false);
  });
});
