import { describe, it, expect } from "vitest";
import {
  backendFamilyFromSessionType,
  connectionErrorHint,
  connectionErrorKindFromCode,
  type BackendFamily,
  type ConnectionErrorKind,
} from "./connectionErrorHints";
import { parseBackendError } from "./backendErrorCode";

const FAMILIES: BackendFamily[] = ["ssh", "telnet", "serial", "docker", "local", "unknown"];

/** Resolve just the hint text (or null) for a (family, kind). */
function hintText(family: BackendFamily, kind: ConnectionErrorKind): string | null {
  return connectionErrorHint(family, kind)?.text ?? null;
}

describe("backendFamilyFromSessionType", () => {
  it("maps known session types to their family", () => {
    expect(backendFamilyFromSessionType("ssh")).toBe("ssh");
    expect(backendFamilyFromSessionType("telnet")).toBe("telnet");
    expect(backendFamilyFromSessionType("serial")).toBe("serial");
    expect(backendFamilyFromSessionType("docker")).toBe("docker");
    expect(backendFamilyFromSessionType("local")).toBe("local");
  });

  it("falls back to 'unknown' for empty or unrecognised types", () => {
    expect(backendFamilyFromSessionType("")).toBe("unknown");
    expect(backendFamilyFromSessionType("wsl")).toBe("unknown");
    expect(backendFamilyFromSessionType("something-new")).toBe("unknown");
  });
});

describe("connectionErrorHint — timeout", () => {
  const families: BackendFamily[] = ["ssh", "telnet", "serial", "docker", "local", "unknown"];

  it("returns a hint for every backend family", () => {
    for (const family of families) {
      expect(hintText(family, "timeout")).toBeTruthy();
    }
  });

  // #2088: a timeout means the transport never connected, so no timeout hint may
  // ever blame the remote agent binary — the exact wording that leaked onto the
  // SSH path in the reported bug.
  it("never mentions the agent binary on any backend", () => {
    for (const family of families) {
      expect(hintText(family, "timeout")).not.toMatch(/agent binary/i);
    }
  });

  it("gives SSH an SSH-appropriate, reachability-focused hint", () => {
    const hint = hintText("ssh", "timeout") ?? "";
    expect(hint).toMatch(/ssh/i);
    expect(hint).toMatch(/reachable/i);
    expect(hint).not.toMatch(/agent binary/i);
  });

  it("gives serial device-oriented guidance, not host reachability", () => {
    const hint = hintText("serial", "timeout") ?? "";
    expect(hint).toMatch(/serial|device|baud/i);
  });

  it("gives docker container guidance", () => {
    expect(hintText("docker", "timeout") ?? "").toMatch(/docker|container/i);
  });
});

describe("connectionErrorKindFromCode", () => {
  it("maps each backend error code to its kind", () => {
    expect(connectionErrorKindFromCode("auth_failed")).toBe("auth");
    expect(connectionErrorKindFromCode("agent_auth_failed")).toBe("agent-auth");
    expect(connectionErrorKindFromCode("timeout")).toBe("timeout");
    expect(connectionErrorKindFromCode("not_found")).toBe("not-found");
    expect(connectionErrorKindFromCode("permission_denied")).toBe("permission");
    expect(connectionErrorKindFromCode("busy")).toBe("busy");
  });

  it("treats a missing or uncategorised code as 'other'", () => {
    expect(connectionErrorKindFromCode(undefined)).toBe("other");
    expect(connectionErrorKindFromCode("spawn_failed")).toBe("other");
    expect(connectionErrorKindFromCode("unreachable")).toBe("other");
    expect(connectionErrorKindFromCode("made_up")).toBe("other");
  });

  // I18N-009: the kind depends only on the code, so a non-English (here German,
  // as a German Windows host would localize it) message still classifies.
  it("classifies a localized message by its code, not its text", () => {
    const parsed = parseBackendError({
      code: "permission_denied",
      message: "Zugriff verweigert auf 'COM3'",
    });
    expect(connectionErrorKindFromCode(parsed.code)).toBe("permission");
    const legacy = parseBackendError("[thub-code:busy] Der Anschluss wird bereits verwendet");
    expect(connectionErrorKindFromCode(legacy.code)).toBe("busy");
  });

  // Conversely, English text that used to trigger a hint by substring match
  // no longer does without the typed code.
  it("ignores hint-like English text without a code", () => {
    for (const message of ["Agent auth failed", "connection timed out", "Permission denied"]) {
      expect(connectionErrorKindFromCode(parseBackendError(message).code)).toBe("other");
    }
  });
});

describe("connectionErrorHint — every kind for every family", () => {
  // The expected presence of a curated hint, per (kind, family). Serial-only
  // device kinds stay on serial; the ssh-agent remedy stays on SSH (#2088).
  const EXPECTED: Record<ConnectionErrorKind, BackendFamily[]> = {
    timeout: FAMILIES,
    auth: ["ssh", "telnet", "unknown"],
    "agent-auth": ["ssh"],
    "not-found": ["serial"],
    permission: ["serial"],
    busy: ["serial"],
    other: [],
  };

  for (const [kind, withHint] of Object.entries(EXPECTED) as [
    ConnectionErrorKind,
    BackendFamily[],
  ][]) {
    for (const family of FAMILIES) {
      const expected = withHint.includes(family);
      it(`${kind} on ${family} ${expected ? "has" : "has no"} hint`, () => {
        const hint = connectionErrorHint(family, kind);
        if (expected) {
          expect(hint?.text).toBeTruthy();
        } else {
          expect(hint).toBeNull();
        }
      });
    }
  }

  it("gives the SSH agent-auth hint a title and the platform start command", () => {
    const hint = connectionErrorHint("ssh", "agent-auth", "linux");
    expect(hint?.title).toBe("SSH Agent not running");
    expect(hint?.command).toContain("ssh-agent");
    expect(connectionErrorHint("ssh", "agent-auth", "windows")?.command).toContain(
      "Start-Service ssh-agent"
    );
  });

  // #1831: only Linux has the dialout group.
  it("offers the dialout fix for a serial permission error only on Linux", () => {
    expect(connectionErrorHint("serial", "permission", "linux")?.command).toBe(
      "sudo usermod -aG dialout $USER"
    );
    for (const platform of ["windows", "macos"] as const) {
      const hint = connectionErrorHint("serial", "permission", platform);
      expect(hint?.command).toBeUndefined();
      expect(hint?.text).not.toMatch(/dialout/);
      expect(hint?.title).toBe("Permission denied");
    }
  });

  it("gives device guidance for serial not-found and busy", () => {
    expect(hintText("serial", "not-found")).toContain("Serial port not found");
    expect(hintText("serial", "busy")).toContain("already in use");
  });
});
