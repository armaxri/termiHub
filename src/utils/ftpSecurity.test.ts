import { describe, it, expect } from "vitest";
import { shouldShowInsecureFtpWarning, ftpPortForTlsMode } from "./ftpSecurity";
import type { ConnectionConfig } from "@/types/terminal";

function ftpConfig(config: Record<string, unknown>): ConnectionConfig {
  return { type: "ftp", config };
}

describe("shouldShowInsecureFtpWarning", () => {
  it("warns for plain FTP (tlsMode none, not suppressed)", () => {
    expect(shouldShowInsecureFtpWarning(ftpConfig({ tlsMode: "none" }))).toBe(true);
  });

  it("warns when tlsMode is unset (defaults to none)", () => {
    expect(shouldShowInsecureFtpWarning(ftpConfig({ host: "h" }))).toBe(true);
  });

  it("does not warn for explicit FTPS", () => {
    expect(shouldShowInsecureFtpWarning(ftpConfig({ tlsMode: "explicit" }))).toBe(false);
  });

  it("does not warn for implicit FTPS", () => {
    expect(shouldShowInsecureFtpWarning(ftpConfig({ tlsMode: "implicit" }))).toBe(false);
  });

  it("does not warn when suppressSecurityWarning is set", () => {
    expect(
      shouldShowInsecureFtpWarning(ftpConfig({ tlsMode: "none", suppressSecurityWarning: true }))
    ).toBe(false);
  });

  it("does not warn for non-FTP connection types", () => {
    expect(shouldShowInsecureFtpWarning({ type: "telnet", config: { host: "h" } })).toBe(false);
    expect(shouldShowInsecureFtpWarning({ type: "ssh", config: {} })).toBe(false);
  });
});

describe("ftpPortForTlsMode", () => {
  it("snaps 21 → 990 when switching to implicit", () => {
    expect(ftpPortForTlsMode("implicit", 21)).toBe(990);
  });

  it("snaps 990 → 21 when switching to none", () => {
    expect(ftpPortForTlsMode("none", 990)).toBe(21);
  });

  it("snaps 990 → 21 when switching to explicit", () => {
    expect(ftpPortForTlsMode("explicit", 990)).toBe(21);
  });

  it("sets the default when the port is unset", () => {
    expect(ftpPortForTlsMode("implicit", undefined)).toBe(990);
    expect(ftpPortForTlsMode("none", undefined)).toBe(21);
  });

  it("leaves a custom port untouched", () => {
    expect(ftpPortForTlsMode("implicit", 2121)).toBeNull();
    expect(ftpPortForTlsMode("none", 2121)).toBeNull();
  });

  it("returns null when the port already matches the target", () => {
    expect(ftpPortForTlsMode("implicit", 990)).toBeNull();
    expect(ftpPortForTlsMode("none", 21)).toBeNull();
  });
});
