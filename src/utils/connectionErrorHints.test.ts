import { describe, it, expect } from "vitest";
import {
  backendFamilyFromSessionType,
  connectionErrorHint,
  type BackendFamily,
} from "./connectionErrorHints";

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
      expect(connectionErrorHint(family, "timeout")).toBeTruthy();
    }
  });

  // #2088: a timeout means the transport never connected, so no timeout hint may
  // ever blame the remote agent binary — the exact wording that leaked onto the
  // SSH path in the reported bug.
  it("never mentions the agent binary on any backend", () => {
    for (const family of families) {
      expect(connectionErrorHint(family, "timeout")).not.toMatch(/agent binary/i);
    }
  });

  it("gives SSH an SSH-appropriate, reachability-focused hint", () => {
    const hint = connectionErrorHint("ssh", "timeout") ?? "";
    expect(hint).toMatch(/ssh/i);
    expect(hint).toMatch(/reachable/i);
    expect(hint).not.toMatch(/agent binary/i);
  });

  it("gives serial device-oriented guidance, not host reachability", () => {
    const hint = connectionErrorHint("serial", "timeout") ?? "";
    expect(hint).toMatch(/serial|device|baud/i);
  });

  it("gives docker container guidance", () => {
    expect(connectionErrorHint("docker", "timeout") ?? "").toMatch(/docker|container/i);
  });
});
