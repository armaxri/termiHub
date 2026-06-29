import { describe, it, expect } from "vitest";
import type { JumpHostConfig } from "@/types/connection";
import { validateProxyJump } from "./validateProxyJump";

function hop(overrides: Partial<JumpHostConfig> = {}): JumpHostConfig {
  return { host: "bastion", port: 22, username: "admin", authMethod: "key", ...overrides };
}

describe("validateProxyJump", () => {
  it("accepts a valid single inline hop", () => {
    const { errors, warnings } = validateProxyJump([hop()]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("accepts an empty chain", () => {
    expect(validateProxyJump([])).toEqual({ errors: [], warnings: [] });
  });

  it("flags a missing host", () => {
    const { errors } = validateProxyJump([hop({ host: "" })]);
    expect(errors).toContain("Jump host: host is required.");
  });

  it("flags a missing username", () => {
    const { errors } = validateProxyJump([hop({ username: "   " })]);
    expect(errors).toContain("Jump host: username is required.");
  });

  it("labels errors per hop number when there are multiple hops", () => {
    const { errors } = validateProxyJump([hop(), hop({ host: "" })]);
    expect(errors).toContain("Hop 2: host is required.");
    expect(errors).not.toContain("Jump host: host is required.");
  });

  it("does not require inline fields for a saved-connection reference", () => {
    const { errors } = validateProxyJump([
      { connectionId: "Work/bastion", host: "", port: 22, username: "", authMethod: "" },
    ]);
    expect(errors).toEqual([]);
  });

  it("warns (but does not error) when the chain exceeds the recommended depth", () => {
    const deep = Array.from({ length: 6 }, () => hop());
    const { errors, warnings } = validateProxyJump(deep);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("6 hops"))).toBe(true);
  });
});
