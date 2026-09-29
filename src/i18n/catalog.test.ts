import { describe, it, expect } from "vitest";
import { t, tf } from "./catalog";

describe("tf", () => {
  it("substitutes named placeholders", () => {
    expect(tf("credentialSwitch.count.other", { count: 4 })).toBe("4 credentials");
    expect(
      tf("credentialSwitch.removed.success", { target: "None", credentials: "1 credential" })
    ).toBe("Switched to None — 1 credential removed.");
  });

  it("leaves a placeholder visible when its parameter is missing", () => {
    expect(tf("credentialSwitch.switched", {})).toBe(t("credentialSwitch.switched"));
    expect(tf("credentialSwitch.switched", {})).toContain("{target}");
  });
});
