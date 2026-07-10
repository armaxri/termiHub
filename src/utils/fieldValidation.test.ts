import { describe, it, expect } from "vitest";
import {
  validateIntRange,
  validatePort,
  validateHost,
  isValidHttpUrl,
  validateMac,
} from "./fieldValidation";

describe("validateIntRange", () => {
  it("accepts an in-range integer", () => {
    expect(validateIntRange(30, { min: 1, max: 255 })).toBeNull();
    expect(validateIntRange(1, { min: 1, max: 255 })).toBeNull();
    expect(validateIntRange(255, { min: 1, max: 255 })).toBeNull();
  });

  it("rejects an empty value unless allowEmpty is set", () => {
    expect(validateIntRange("", { min: 1, max: 10, label: "Count" })).toBe("Count is required");
    expect(validateIntRange(null, { min: 1, max: 10, label: "Count" })).toBe("Count is required");
    expect(validateIntRange(undefined, { min: 1, max: 10 })).toBe("Value is required");
    expect(validateIntRange("", { min: 1, max: 10, allowEmpty: true })).toBeNull();
  });

  it("rejects NaN", () => {
    expect(validateIntRange(Number.NaN, { min: 1, max: 10 })).toBe("Value is required");
  });

  it("rejects non-integers", () => {
    expect(validateIntRange(1.5, { min: 1, max: 10, label: "Hops" })).toBe(
      "Hops must be a whole number"
    );
  });

  it("rejects out-of-range values", () => {
    expect(validateIntRange(0, { min: 1, max: 255, label: "Max hops" })).toBe(
      "Max hops must be between 1 and 255"
    );
    expect(validateIntRange(256, { min: 1, max: 255, label: "Max hops" })).toBe(
      "Max hops must be between 1 and 255"
    );
  });
});

describe("validatePort", () => {
  it("accepts 1..65535", () => {
    expect(validatePort(1)).toBeNull();
    expect(validatePort(22)).toBeNull();
    expect(validatePort(65535)).toBeNull();
  });

  it("rejects 0, blank, and >65535 (the parseInt||0 regressions)", () => {
    expect(validatePort(0)).toBe("Port must be between 1 and 65535");
    expect(validatePort(65536)).toBe("Port must be between 1 and 65535");
    expect(validatePort("")).toBe("Port is required");
  });

  it("uses a custom label", () => {
    expect(validatePort(0, { label: "Local port" })).toBe("Local port must be between 1 and 65535");
  });
});

describe("validateHost", () => {
  it("accepts a non-empty host", () => {
    expect(validateHost("example.com")).toBeNull();
    expect(validateHost("127.0.0.1")).toBeNull();
  });

  it("rejects blank/whitespace hosts", () => {
    expect(validateHost("")).toBe("Host is required");
    expect(validateHost("   ")).toBe("Host is required");
    expect(validateHost(undefined)).toBe("Host is required");
    expect(validateHost("", "Remote host")).toBe("Remote host is required");
  });
});

describe("isValidHttpUrl", () => {
  it("accepts real http(s) URLs", () => {
    expect(isValidHttpUrl("https://example.com")).toBe(true);
    expect(isValidHttpUrl("http://example.com/health")).toBe(true);
    expect(isValidHttpUrl("https://10.0.0.1:8443/status")).toBe(true);
  });

  it("rejects empty input and the bare scheme sentinel", () => {
    expect(isValidHttpUrl("")).toBe(false);
    expect(isValidHttpUrl("   ")).toBe(false);
    expect(isValidHttpUrl("https://")).toBe(false);
  });

  it("rejects non-http schemes and garbage", () => {
    expect(isValidHttpUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
    expect(isValidHttpUrl("example.com")).toBe(false);
  });
});

describe("validateMac", () => {
  it("accepts colon- and hyphen-separated MAC addresses", () => {
    expect(validateMac("AA:BB:CC:DD:EE:FF")).toBeNull();
    expect(validateMac("aa:bb:cc:dd:ee:ff")).toBeNull();
    expect(validateMac("01-23-45-67-89-AB")).toBeNull();
    expect(validateMac("  00:11:22:33:44:55  ")).toBeNull();
  });

  it("rejects an empty value", () => {
    expect(validateMac("")).toBe("MAC address is required");
    expect(validateMac("   ")).toBe("MAC address is required");
    expect(validateMac(null)).toBe("MAC address is required");
    expect(validateMac(undefined)).toBe("MAC address is required");
  });

  it("rejects malformed MAC addresses", () => {
    // Wrong group count / length
    expect(validateMac("AA:BB:CC:DD:EE")).not.toBeNull();
    expect(validateMac("AA:BB:CC:DD:EE:FF:00")).not.toBeNull();
    // Non-hex characters
    expect(validateMac("GG:BB:CC:DD:EE:FF")).not.toBeNull();
    // Mixed / missing separators
    expect(validateMac("AABBCCDDEEFF")).not.toBeNull();
    expect(validateMac("AA:BB-CC:DD:EE:FF")).not.toBeNull();
  });
});
