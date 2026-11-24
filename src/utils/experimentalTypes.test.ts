import { describe, it, expect } from "vitest";
import type { ConnectionTypeInfo } from "@/types/connection";
import {
  PREVIEW_BADGE_LABEL,
  isExperimentalConnectionType,
  experimentalTypeIds,
  buildGatedTypeOptions,
  previewTypeNote,
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
const LOCAL = makeType("local", "Local shell");
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

  it("flags experimental types as preview and keeps their plain names (#5873)", () => {
    const opts = buildGatedTypeOptions(registry, true);
    const byValue = Object.fromEntries(opts.map((o) => [o.value, o]));
    expect(byValue.ssh).toEqual({ value: "ssh", label: "SSH", preview: false });
    expect(byValue.vnc).toEqual({ value: "vnc", label: "VNC", preview: true });
    expect(byValue.rdp).toEqual({ value: "rdp", label: "RDP", preview: true });
    expect(byValue["mock-remote-desktop"].label).toBe("Mock Remote Desktop");
    // No "— Experimental" suffix anywhere in a label (R-166).
    expect(opts.some((o) => /experimental/i.test(o.label))).toBe(false);
  });

  it("retains the currently-selected experimental type even when the flag is off", () => {
    const opts = buildGatedTypeOptions(registry, false, "vnc");
    const values = opts.map((o) => o.value);
    expect(values).toContain("vnc");
    expect(values).not.toContain("rdp");
    // Still flagged preview so the user sees why it is unusual.
    expect(opts.find((o) => o.value === "vnc")?.preview).toBe(true);
  });
});

describe("preview badge and note (#5873)", () => {
  it("uses a neutral Preview badge", () => {
    expect(PREVIEW_BADGE_LABEL).toBe("Preview");
  });

  it("is one line naming that the type is still being tested", () => {
    const note = previewTypeNote("rdp");
    expect(note).toMatch(/^Preview: still being tested/);
    expect(note).not.toMatch(/\n/);
  });

  it("adds a type's known limits", () => {
    expect(previewTypeNote("vnc")).toContain("VNC has no audio.");
    expect(previewTypeNote("rdp")).not.toContain("audio");
  });
});
