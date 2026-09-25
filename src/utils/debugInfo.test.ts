import { describe, it, expect } from "vitest";
import { buildDebugInfo, type DebugInfoFields } from "./debugInfo";

const base: DebugInfoFields = {
  version: "0.1.0-dev",
  gitHash: "abc1234",
  buildBranch: "develop",
  isDev: true,
  platform: "macos",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  logFilePath: "/Users/me/Library/Logs/termihub/termihub.log",
  credentialStoreMode: "os_keychain",
  credentialStoreStatus: "unlocked",
};

describe("buildDebugInfo", () => {
  it("includes every gathered field", () => {
    const out = buildDebugInfo(base);
    expect(out).toContain("termiHub debug info");
    expect(out).toContain("0.1.0-dev");
    expect(out).toContain("abc1234");
    expect(out).toContain("develop");
    expect(out).toContain("macos");
    expect(out).toContain("Mac OS X 10_15_7");
    expect(out).toContain("/Users/me/Library/Logs/termihub/termihub.log");
    expect(out).toContain("os_keychain (unlocked)");
    expect(out).toContain("Dev build:");
  });

  it("renders yes/no for the dev-build flag", () => {
    expect(buildDebugInfo({ ...base, isDev: false })).toContain("no");
    expect(buildDebugInfo({ ...base, isDev: true })).toMatch(/Dev build:\s+yes/);
  });

  it("falls back to 'unknown' for unresolved fields", () => {
    const out = buildDebugInfo({
      ...base,
      version: null,
      gitHash: null,
      buildBranch: null,
      isDev: null,
      logFilePath: null,
      credentialStoreMode: null,
      credentialStoreStatus: null,
    });
    expect(out).toContain("App version:      unknown");
    expect(out).toContain("Log file:         unknown");
    expect(out).toContain("Credential store: unknown");
    expect(out).toContain("Dev build:        unknown");
  });

  it("shows the mode alone when status is absent", () => {
    const out = buildDebugInfo({ ...base, credentialStoreStatus: null });
    expect(out).toContain("Credential store: os_keychain");
    expect(out).not.toContain("os_keychain (");
  });

  it("runs the bundle through redaction as defense-in-depth", () => {
    const out = buildDebugInfo({
      ...base,
      // A pathological log path carrying a credential must still be masked.
      logFilePath: "smb://user:s3cr3t@share/logs/termihub.log",
    });
    expect(out).toContain("***redacted***");
    expect(out).not.toContain("s3cr3t");
  });
});
