import { describe, it, expect } from "vitest";
import {
  backendFamilyFromSessionType,
  connectionErrorHeading,
  connectionErrorHint,
  connectionErrorKindFromCode,
  isNetworkErrorKind,
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
    // TCP connect categories (#5183).
    expect(connectionErrorKindFromCode("refused")).toBe("refused");
    expect(connectionErrorKindFromCode("unreachable")).toBe("unreachable");
    expect(connectionErrorKindFromCode("dns")).toBe("dns");
  });

  it("treats a missing or uncategorised code as 'other'", () => {
    expect(connectionErrorKindFromCode(undefined)).toBe("other");
    expect(connectionErrorKindFromCode("spawn_failed")).toBe("other");
    expect(connectionErrorKindFromCode("connection_failed")).toBe("other");
    // #3959: an agent that never answered is not a connect-transport timeout, so
    // it must not show the "check the host is reachable" timeout hint.
    expect(connectionErrorKindFromCode("agent_timeout")).toBe("other");
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
    "not-found": ["serial", "docker"],
    permission: ["serial"],
    busy: ["serial"],
    // Only network backends raise these; the copy is family-neutral (#5183).
    refused: FAMILIES,
    unreachable: FAMILIES,
    dns: FAMILIES,
    // Only SSH has a host key to reject (#5185).
    "host-key-rejected": ["ssh", "unknown"],
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

  // #4368: the backend now reports a held COM port as "busy", so the Windows
  // permission hint must no longer guess that another program holds the port.
  it("gives a pure permission hint for a serial permission error on Windows", () => {
    const hint = connectionErrorHint("serial", "permission", "windows");
    expect(hint?.text).toContain("permission");
    expect(hint?.text).not.toMatch(/another application/i);
  });

  it("gives device guidance for serial not-found and busy", () => {
    expect(hintText("serial", "not-found")).toContain("Serial port not found");
    expect(hintText("serial", "busy")).toContain("already in use");
  });

  it("gives container guidance for docker not-found (#3784)", () => {
    expect(hintText("docker", "not-found")).toContain("Container not found");
    expect(hintText("docker", "not-found")).toContain("docker compose up");
  });
});

describe("network failure kinds (#5183)", () => {
  it("explain a refused, unreachable and unresolvable host in plain language", () => {
    expect(hintText("ssh", "refused")).toMatch(/nothing is accepting connections on this port/i);
    expect(hintText("ssh", "refused")).toMatch(/port number/i);
    expect(hintText("telnet", "unreachable")).toMatch(/network or VPN/i);
    expect(hintText("ssh", "dns")).toMatch(/host name could not be resolved/i);
  });

  it("never echo an OS error code", () => {
    for (const kind of ["refused", "unreachable", "dns"] as const) {
      expect(hintText("ssh", kind)).not.toMatch(/os error|errno|\d{2,}/i);
    }
  });

  it("name themselves in the failure heading; other kinds keep the generic one", () => {
    expect(connectionErrorHeading("refused")).toBe("Connection refused");
    expect(connectionErrorHeading("unreachable")).toBe("Host unreachable");
    expect(connectionErrorHeading("dns")).toBe("Host not found");
    expect(connectionErrorHeading("timeout")).toBeNull();
    expect(connectionErrorHeading("other")).toBeNull();
  });

  it("are the only network kinds", () => {
    expect(isNetworkErrorKind("refused")).toBe(true);
    expect(isNetworkErrorKind("unreachable")).toBe(true);
    expect(isNetworkErrorKind("dns")).toBe(true);
    expect(isNetworkErrorKind("timeout")).toBe(false);
    expect(isNetworkErrorKind("auth")).toBe(false);
  });

  // The wire shape the backend sends for a refused connect (the envelope of
  // `TerminalError::from_session_spawn` for a core `Refused`).
  it("classify the refused IPC envelope by its code", () => {
    const parsed = parseBackendError({
      code: "refused",
      message: "db.internal:2222: Connection refused (os error 61)",
      details: null,
    });
    expect(connectionErrorKindFromCode(parsed.code)).toBe("refused");
    expect(parsed.message).toBe("db.internal:2222: Connection refused (os error 61)");
    expect(parsed.message).not.toMatch(/failed:.*failed:/i);
  });
});

describe("rejected host key (#5185)", () => {
  it("maps host_key_untrusted to host-key-rejected with its own heading and hint", () => {
    expect(connectionErrorKindFromCode("host_key_untrusted")).toBe("host-key-rejected");
    expect(connectionErrorHeading("host-key-rejected")).toBe("You rejected the host key");
    expect(connectionErrorHint("ssh", "host-key-rejected")?.text).toMatch(
      /rejected the server's host key/
    );
    expect(isNetworkErrorKind("host-key-rejected")).toBe(false);
  });
});
