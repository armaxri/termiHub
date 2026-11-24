import { describe, it, expect } from "vitest";
import {
  EXPERIMENTAL_FEATURE_NAMES,
  EXPERIMENTAL_SETTING_HINT,
  EXPERIMENTAL_SETTING_LABEL,
} from "./experimentalSetting";
import { filterSettings } from "@/components/Settings/settingsRegistry";

describe("experimental setting copy (#5858)", () => {
  it("lists what is still behind the switch", () => {
    expect(EXPERIMENTAL_SETTING_HINT).toBe(
      "Turns on features still under active development: workflows, remote agents " +
        "and RDP and VNC remote desktop. They may change, break, or be removed without notice."
    );
    for (const name of EXPERIMENTAL_FEATURE_NAMES) {
      expect(EXPERIMENTAL_SETTING_HINT).toContain(name);
    }
  });

  it("no longer names the graduated features", () => {
    expect(EXPERIMENTAL_SETTING_HINT).not.toMatch(/tunnel|services|network tools/i);
  });

  it("the settings-search entry carries the same hint", () => {
    const entry = filterSettings(EXPERIMENTAL_SETTING_LABEL).find(
      (s) => s.id === "experimentalFeaturesEnabled"
    );
    expect(entry?.description).toBe(EXPERIMENTAL_SETTING_HINT);
  });
});
