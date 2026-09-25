import { describe, expect, it } from "vitest";
import { isAutoReconnectEnabled } from "./autoReconnect";

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
