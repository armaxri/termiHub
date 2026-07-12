import { describe, it, expect } from "vitest";
import type { JumpHostConfig, SavedConnection } from "@/types/connection";
import { validateProxyJump } from "./validateProxyJump";

function hop(overrides: Partial<JumpHostConfig> = {}): JumpHostConfig {
  return { host: "bastion", port: 22, username: "admin", authMethod: "key", ...overrides };
}

/** A saved SSH connection, optionally with its own jump-host chain. */
function sshConn(id: string, hops: JumpHostConfig[] = [], type = "ssh"): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type, config: hops.length ? { proxyJump: hops } : {} },
  };
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

  it("flags a blank inline port as required (#1444)", () => {
    const { errors } = validateProxyJump([hop({ port: "" })]);
    expect(errors).toContain("Jump host: port is required.");
  });

  it("flags an out-of-range inline port (#1444)", () => {
    const { errors } = validateProxyJump([hop({ port: 70000 })]);
    expect(errors).toContain("Jump host: port must be between 1 and 65535.");
  });

  it("does not require a port for a saved-connection reference (#1444)", () => {
    const ctx = { connections: [sshConn("Work/bastion")] };
    const { errors } = validateProxyJump(
      [{ connectionId: "Work/bastion", host: "", port: "", username: "", authMethod: "" }],
      ctx
    );
    expect(errors).toEqual([]);
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

  describe("with saved-connection references (#940)", () => {
    it("accepts a reference to an existing SSH connection", () => {
      const ctx = { connections: [sshConn("Work/bastion")] };
      const { errors } = validateProxyJump([hop({ connectionId: "Work/bastion" })], ctx);
      expect(errors).toEqual([]);
    });

    it("flags a reference to a connection that no longer exists", () => {
      const { errors } = validateProxyJump([hop({ connectionId: "ghost" })], { connections: [] });
      expect(errors.some((e) => e.includes("not found"))).toBe(true);
    });

    it("flags a reference to a non-SSH connection", () => {
      const local = sshConn("loc", [], "local");
      const { errors } = validateProxyJump([hop({ connectionId: "loc" })], {
        connections: [local],
      });
      expect(errors.some((e) => e.includes("not an SSH connection"))).toBe(true);
    });

    it("detects a direct circular reference (A → B → A)", () => {
      const a = sshConn("A", [hop({ connectionId: "B" })]);
      const b = sshConn("B", [hop({ connectionId: "A" })]);
      const { errors } = validateProxyJump([hop({ connectionId: "A" })], {
        connections: [a, b],
        currentConnectionId: "self",
      });
      expect(errors.some((e) => e.includes("Circular"))).toBe(true);
    });

    it("detects a hop that routes back through the connection being edited", () => {
      // Editing connection "me"; a hop references "gw", whose chain points back to "me".
      const gw = sshConn("gw", [hop({ connectionId: "me" })]);
      const me = sshConn("me");
      const { errors } = validateProxyJump([hop({ connectionId: "gw" })], {
        connections: [gw, me],
        currentConnectionId: "me",
      });
      expect(errors.some((e) => e.includes("Circular"))).toBe(true);
    });

    it("accepts a non-circular nested reference chain", () => {
      const a = sshConn("A", [hop({ connectionId: "B" })]);
      const b = sshConn("B");
      const { errors } = validateProxyJump([hop({ connectionId: "A" })], {
        connections: [a, b],
        currentConnectionId: "self",
      });
      expect(errors).toEqual([]);
    });

    it("skips reference checks entirely when no context is provided", () => {
      const { errors } = validateProxyJump([hop({ connectionId: "ghost" })]);
      expect(errors).toEqual([]);
    });
  });
});
