import { describe, it, expect } from "vitest";
import type { ConnectionConfig } from "@/types/terminal";
import {
  connectionConfigFields,
  readConfigString,
  readConfigBoolean,
  readConfigNumber,
  connectionConfigHost,
} from "./connectionConfigFields";

const cfg = (config: Record<string, unknown>): ConnectionConfig => ({ type: "ssh", config });

describe("connectionConfigFields", () => {
  it("returns the raw settings bag", () => {
    const c = cfg({ host: "example.com", port: 22 });
    expect(connectionConfigFields(c)).toEqual({ host: "example.com", port: 22 });
  });

  it("returns an empty object for undefined / null config", () => {
    expect(connectionConfigFields(undefined)).toEqual({});
    expect(connectionConfigFields(null)).toEqual({});
  });
});

describe("readConfigString", () => {
  it("reads a string field", () => {
    expect(readConfigString(cfg({ host: "example.com" }), "host")).toBe("example.com");
  });

  it("returns an empty string when the field is an empty string", () => {
    expect(readConfigString(cfg({ host: "" }), "host")).toBe("");
  });

  it("returns undefined for a non-string field", () => {
    expect(readConfigString(cfg({ host: 123 }), "host")).toBeUndefined();
    expect(readConfigString(cfg({ host: true }), "host")).toBeUndefined();
    expect(readConfigString(cfg({ host: null }), "host")).toBeUndefined();
  });

  it("returns undefined for a missing field or missing config", () => {
    expect(readConfigString(cfg({}), "host")).toBeUndefined();
    expect(readConfigString(undefined, "host")).toBeUndefined();
  });
});

describe("readConfigBoolean", () => {
  it("reads a boolean field", () => {
    expect(readConfigBoolean(cfg({ enableMonitoring: true }), "enableMonitoring")).toBe(true);
    expect(readConfigBoolean(cfg({ enableMonitoring: false }), "enableMonitoring")).toBe(false);
  });

  it("returns undefined for a non-boolean field (no truthy coercion)", () => {
    expect(readConfigBoolean(cfg({ enableMonitoring: "true" }), "enableMonitoring")).toBeUndefined();
    expect(readConfigBoolean(cfg({ enableMonitoring: 1 }), "enableMonitoring")).toBeUndefined();
  });

  it("returns undefined for a missing field or missing config", () => {
    expect(readConfigBoolean(cfg({}), "enableMonitoring")).toBeUndefined();
    expect(readConfigBoolean(undefined, "enableMonitoring")).toBeUndefined();
  });
});

describe("readConfigNumber", () => {
  it("reads a number field", () => {
    expect(readConfigNumber(cfg({ port: 22 }), "port")).toBe(22);
    expect(readConfigNumber(cfg({ port: 0 }), "port")).toBe(0);
  });

  it("returns undefined for a non-number field", () => {
    expect(readConfigNumber(cfg({ port: "22" }), "port")).toBeUndefined();
    expect(readConfigNumber(undefined, "port")).toBeUndefined();
  });
});

describe("connectionConfigHost", () => {
  it("returns the host when declared", () => {
    expect(connectionConfigHost(cfg({ host: "example.com" }))).toBe("example.com");
  });

  it("returns an empty string when no host is declared", () => {
    expect(connectionConfigHost(cfg({}))).toBe("");
    expect(connectionConfigHost(cfg({ host: 123 }))).toBe("");
    expect(connectionConfigHost(undefined)).toBe("");
  });
});
