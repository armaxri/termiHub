import { describe, it, expect } from "vitest";
import { parseQuickConnect, quickConnectConfig } from "./quickConnect";

describe("parseQuickConnect", () => {
  it("parses user@host", () => {
    expect(parseQuickConnect("admin@prod-db")).toEqual({
      username: "admin",
      host: "prod-db",
      port: 22,
    });
  });

  it("parses user@host:port", () => {
    expect(parseQuickConnect("admin@prod-db:2222")).toEqual({
      username: "admin",
      host: "prod-db",
      port: 2222,
    });
  });

  it("uses the default user when the user is omitted", () => {
    expect(parseQuickConnect("prod-db", "root")).toEqual({
      username: "root",
      host: "prod-db",
      port: 22,
    });
  });

  it("leaves username undefined when omitted and no default", () => {
    expect(parseQuickConnect("prod-db")).toEqual({
      username: undefined,
      host: "prod-db",
      port: 22,
    });
  });

  it("parses bracketed IPv6 with a port", () => {
    expect(parseQuickConnect("admin@[::1]:2222")).toEqual({
      username: "admin",
      host: "::1",
      port: 2222,
    });
  });

  it("returns null for empty or host-less input", () => {
    expect(parseQuickConnect("")).toBeNull();
    expect(parseQuickConnect("   ")).toBeNull();
    expect(parseQuickConnect("user@")).toBeNull();
  });

  it("prefers an explicit user over the default", () => {
    expect(parseQuickConnect("me@host", "root")?.username).toBe("me");
  });
});

describe("quickConnectConfig", () => {
  it("builds an SSH config with user, host and port", () => {
    expect(quickConnectConfig({ username: "admin", host: "h", port: 22 })).toEqual({
      type: "ssh",
      config: { host: "h", port: 22, username: "admin" },
    });
  });

  it("omits the username when absent", () => {
    expect(quickConnectConfig({ host: "h", port: 22 })).toEqual({
      type: "ssh",
      config: { host: "h", port: 22 },
    });
  });
});
