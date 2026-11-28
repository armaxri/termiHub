import { describe, it, expect } from "vitest";
import { SETTINGS_COMPACT_BELOW_PX, isCompactSettingsWidth } from "./settingsCompact";

describe("the settings icon rail (#6153)", () => {
  it("takes over below about 640 px of panel width, so the form column stays readable", () => {
    expect(SETTINGS_COMPACT_BELOW_PX).toBe(640);
    // An 800×600 window with the sidebar open leaves about 480–560 px.
    expect(isCompactSettingsWidth(560)).toBe(true);
    expect(isCompactSettingsWidth(639)).toBe(true);
    expect(isCompactSettingsWidth(640)).toBe(false);
    // A 1280×800 window keeps the labelled list.
    expect(isCompactSettingsWidth(980)).toBe(false);
  });
});
