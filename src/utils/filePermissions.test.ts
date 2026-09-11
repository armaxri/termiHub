import { describe, it, expect } from "vitest";
import {
  parsePermissionString,
  formatPermissionString,
  modeToOctalString,
  parseOctalString,
  modeToTriple,
  tripleToMode,
} from "./filePermissions";

describe("parsePermissionString", () => {
  it("parses a 9-char rwx string", () => {
    expect(parsePermissionString("rwxr-xr-x")).toBe(0o755);
    expect(parsePermissionString("rw-r--r--")).toBe(0o644);
    expect(parsePermissionString("rwxrwxrwx")).toBe(0o777);
    expect(parsePermissionString("---------")).toBe(0o000);
  });

  it("tolerates and ignores a leading file-type char", () => {
    expect(parsePermissionString("drwxr-xr-x")).toBe(0o755);
    expect(parsePermissionString("-rw-r--r--")).toBe(0o644);
  });

  it("treats setuid/sticky exec markers as an execute bit", () => {
    // rwsr-xr-x — owner exec shown as 's'
    expect(parsePermissionString("rwsr-xr-x")).toBe(0o755);
    // rwxr-xr-t — sticky on other
    expect(parsePermissionString("rwxr-xr-t")).toBe(0o755);
  });

  it("returns null for malformed input", () => {
    expect(parsePermissionString("")).toBeNull();
    expect(parsePermissionString("rwx")).toBeNull();
    expect(parsePermissionString("zzzzzzzzz")).toBeNull();
  });
});

describe("formatPermissionString", () => {
  it("formats a numeric mode as rwx", () => {
    expect(formatPermissionString(0o755)).toBe("rwxr-xr-x");
    expect(formatPermissionString(0o644)).toBe("rw-r--r--");
    expect(formatPermissionString(0o000)).toBe("---------");
  });

  it("round-trips with parsePermissionString", () => {
    for (const mode of [0o755, 0o644, 0o600, 0o777, 0o000, 0o750]) {
      expect(parsePermissionString(formatPermissionString(mode))).toBe(mode);
    }
  });
});

describe("modeToOctalString / parseOctalString", () => {
  it("renders a 3-digit octal", () => {
    expect(modeToOctalString(0o755)).toBe("755");
    expect(modeToOctalString(0o644)).toBe("644");
    expect(modeToOctalString(0o7)).toBe("007");
  });

  it("parses valid octal strings", () => {
    expect(parseOctalString("755")).toBe(0o755);
    expect(parseOctalString("0644")).toBe(0o644);
    expect(parseOctalString(" 600 ")).toBe(0o600);
  });

  it("rejects invalid octal strings", () => {
    expect(parseOctalString("")).toBeNull();
    expect(parseOctalString("8")).toBeNull();
    expect(parseOctalString("75")).toBeNull();
    expect(parseOctalString("99999")).toBeNull();
    expect(parseOctalString("abc")).toBeNull();
  });
});

describe("modeToTriple / tripleToMode", () => {
  it("decomposes a mode into the grid", () => {
    const t = modeToTriple(0o754);
    expect(t.owner).toEqual({ read: true, write: true, execute: true });
    expect(t.group).toEqual({ read: true, write: false, execute: true });
    expect(t.other).toEqual({ read: true, write: false, execute: false });
  });

  it("recomposes the mode from the grid", () => {
    for (const mode of [0o755, 0o644, 0o600, 0o777, 0o000, 0o751]) {
      expect(tripleToMode(modeToTriple(mode))).toBe(mode);
    }
  });
});
