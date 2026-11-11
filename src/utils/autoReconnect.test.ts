import { describe, expect, it } from "vitest";
import { autoReconnectDefaultFor, isAutoReconnectEnabled } from "./autoReconnect";

describe("isAutoReconnectEnabled (PARITY-008)", () => {
  it("defaults to on when neither key is present", () => {
    expect(isAutoReconnectEnabled({ host: "h" })).toBe(true);
    expect(isAutoReconnectEnabled(undefined)).toBe(true);
  });

  it("reads the unified autoReconnect key", () => {
    expect(isAutoReconnectEnabled({ autoReconnect: false })).toBe(false);
    expect(isAutoReconnectEnabled({ autoReconnect: true })).toBe(true);
  });

  it("falls back to the legacy resilientReconnect key", () => {
    expect(isAutoReconnectEnabled({ resilientReconnect: false })).toBe(false);
    expect(isAutoReconnectEnabled({ resilientReconnect: true })).toBe(true);
  });

  it("prefers the unified key over the legacy key", () => {
    expect(isAutoReconnectEnabled({ autoReconnect: false, resilientReconnect: true })).toBe(false);
  });

  it("ignores non-boolean values", () => {
    expect(isAutoReconnectEnabled({ autoReconnect: "no" })).toBe(true);
  });
});

describe("per-type auto-reconnect defaults (#5390)", () => {
  it("serial and ssh are on, telnet is off when the key is absent", () => {
    expect(autoReconnectDefaultFor("serial")).toBe(true);
    expect(autoReconnectDefaultFor("ssh")).toBe(true);
    expect(autoReconnectDefaultFor("telnet")).toBe(false);
    expect(isAutoReconnectEnabled({ port: "COM3" }, "serial")).toBe(true);
    expect(isAutoReconnectEnabled({ host: "h" }, "telnet")).toBe(false);
  });

  it("keeps an existing SSH choice, legacy key included (migration)", () => {
    expect(isAutoReconnectEnabled({ autoReconnect: false }, "ssh")).toBe(false);
    expect(isAutoReconnectEnabled({ resilientReconnect: false }, "ssh")).toBe(false);
    expect(isAutoReconnectEnabled({}, "ssh")).toBe(true);
  });

  it("an explicit choice wins over the type default", () => {
    expect(isAutoReconnectEnabled({ autoReconnect: true }, "telnet")).toBe(true);
    expect(isAutoReconnectEnabled({ autoReconnect: false }, "serial")).toBe(false);
  });
});
