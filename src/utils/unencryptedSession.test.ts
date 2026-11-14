import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
import { isUnencryptedSession, isUnencryptedTransport } from "./unencryptedSession";

describe("isUnencryptedSession (#5749)", () => {
  it("flags direct and agent telnet sessions", () => {
    expect(isUnencryptedSession({ type: "telnet", config: { host: "h" } })).toBe(true);
    expect(
      isUnencryptedSession({
        type: "remote-session",
        config: { sessionType: "telnet" },
      } as ConnectionConfig)
    ).toBe(true);
  });

  it("does not flag encrypted or local sessions", () => {
    expect(isUnencryptedSession({ type: "ssh", config: { host: "h" } })).toBe(false);
    expect(
      isUnencryptedSession({
        type: "remote-session",
        config: { sessionType: "shell" },
      } as ConnectionConfig)
    ).toBe(false);
    expect(isUnencryptedSession(undefined)).toBe(false);
    expect(isUnencryptedSession(null)).toBe(false);
  });
});

describe("isUnencryptedTransport (#5749)", () => {
  it("matches the telnet display name only", () => {
    expect(isUnencryptedTransport("Telnet")).toBe(true);
    expect(isUnencryptedTransport("telnet")).toBe(true);
    expect(isUnencryptedTransport("SSH")).toBe(false);
    expect(isUnencryptedTransport("")).toBe(false);
    expect(isUnencryptedTransport(undefined)).toBe(false);
  });
});
