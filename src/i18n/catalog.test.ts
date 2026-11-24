import { describe, it, expect } from "vitest";
import { t, tf } from "./catalog";

describe("tf", () => {
  it("substitutes named placeholders", () => {
    expect(tf("credentialSwitch.passwords.other", { count: 4 })).toBe("4 saved passwords");
    expect(tf("credentialSwitch.result.stopped.removed", { passwords: "1 saved password" })).toBe(
      "Stopped saving passwords. 1 saved password removed."
    );
  });

  it("leaves a placeholder visible when its parameter is missing", () => {
    expect(tf("credentialSwitch.progress.move", {})).toBe(t("credentialSwitch.progress.move"));
    expect(tf("credentialSwitch.progress.move", {})).toContain("{passwords}");
  });
});
