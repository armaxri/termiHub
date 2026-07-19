import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/types/connection";
import {
  EXPERIMENTAL_TYPE_SUFFIX,
  isExperimentalConnectionType,
  experimentalTypeIds,
  buildGatedTypeOptions,
} from "./experimentalTypes";

function makeType(typeId: string, displayName: string, graphical = false): ConnectionTypeInfo {
  return {
    typeId,
    displayName,
    icon: "monitor",
    schema: { groups: [] },
    capabilities: {
      monitoring: false,
      fileBrowser: false,
      resize: true,
      persistent: false,
      graphical,
    },
  };
}

const SSH = makeType("ssh", "SSH");
const LOCAL = makeType("local", "Local Shell");
const VNC = makeType("vnc", "VNC", true);
const RDP = makeType("rdp", "RDP", true);
const MOCK = makeType("mock-remote-desktop", "Mock Remote Desktop", true);

describe("isExperimentalConnectionType", () => {
  it("treats graphical remote-desktop types as experimental", () => {
    expect(isExperimentalConnectionType(VNC)).toBe(true);
    expect(isExperimentalConnectionType(RDP)).toBe(true);
    expect(isExperimentalConnectionType(MOCK)).toBe(true);
  });

  it("treats terminal/file-browser types as non-experimental", () => {
    expect(isExperimentalConnectionType(SSH)).toBe(false);
    expect(isExperimentalConnectionType(LOCAL)).toBe(false);
  });
});

describe("experimentalTypeIds", () => {
  it("collects only the graphical type IDs", () => {
    const ids = experimentalTypeIds([SSH, LOCAL, VNC, RDP, MOCK]);
    expect(ids).toEqual(new Set(["vnc", "rdp", "mock-remote-desktop"]));
  });
});

describe("buildGatedTypeOptions", () => {
  const registry = [SSH, LOCAL, VNC, RDP, MOCK];

  it("hides experimental types when the flag is off", () => {
    const opts = buildGatedTypeOptions(registry, false);
    const values = opts.map((o) => o.value);
    expect(values).toEqual(["ssh", "local"]);
    expect(values).not.toContain("vnc");
    expect(values).not.toContain("rdp");
    expect(values).not.toContain("mock-remote-desktop");
  });

  it("shows experimental types labelled '— Experimental' when the flag is on", () => {
    const opts = buildGatedTypeOptions(registry, true);
    const byValue = Object.fromEntries(opts.map((o) => [o.value, o.label]));
    expect(byValue.ssh).toBe("SSH");
    expect(byValue.vnc).toBe("VNC" + EXPERIMENTAL_TYPE_SUFFIX);
    expect(byValue.rdp).toBe("RDP" + EXPERIMENTAL_TYPE_SUFFIX);
    expect(byValue["mock-remote-desktop"]).toBe("Mock Remote Desktop" + EXPERIMENTAL_TYPE_SUFFIX);
  });

  it("does not suffix non-experimental labels when the flag is on", () => {
    const opts = buildGatedTypeOptions(registry, true);
    expect(opts.find((o) => o.value === "ssh")?.label).toBe("SSH");
  });

  it("retains the currently-selected experimental type even when the flag is off", () => {
    const opts = buildGatedTypeOptions(registry, false, "vnc");
    const values = opts.map((o) => o.value);
    expect(values).toContain("vnc");
    expect(values).not.toContain("rdp");
    // Still labelled experimental so the user sees why it is unusual.
    expect(opts.find((o) => o.value === "vnc")?.label).toBe("VNC" + EXPERIMENTAL_TYPE_SUFFIX);
  });
});
