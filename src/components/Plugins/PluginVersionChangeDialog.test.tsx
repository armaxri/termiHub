/**
 * Tests for the plugin version-change confirmation copy (PLG-012): each risky
 * kind names both versions so the user knows what they are replacing.
 */
import { describe, it, expect } from "vitest";
import type { PluginVersionChange } from "@/types/plugin";
import { versionChangeCopy } from "./PluginVersionChangeDialog";

function change(overrides: Partial<PluginVersionChange>): PluginVersionChange {
  return {
    pluginId: "acme",
    pluginName: "Acme",
    installedVersion: "1.4.0",
    incomingVersion: "1.2.0",
    kind: "downgrade",
    ...overrides,
  };
}

describe("versionChangeCopy (PLG-012)", () => {
  it("names both versions for a downgrade", () => {
    const copy = versionChangeCopy(change({}));
    expect(copy.title).toBe("Downgrade Acme?");
    expect(copy.message).toContain("Replace Acme 1.4.0 with older 1.2.0?");
    expect(copy.confirmLabel).toBe("Downgrade");
  });

  it("explains a same-version rebuild", () => {
    const copy = versionChangeCopy(
      change({ kind: "sameVersionChanged", installedVersion: "1.2.0", incomingVersion: "1.2.0" })
    );
    expect(copy.title).toBe("Replace Acme 1.2.0?");
    expect(copy.message).toContain("contents differ");
  });

  it("is conservative for an uncomparable version, even with no installed version", () => {
    const copy = versionChangeCopy(
      change({ kind: "unverifiable", installedVersion: null, incomingVersion: "nightly" })
    );
    expect(copy.message).toContain("cannot tell whether nightly is newer or older");
    expect(copy.message).toContain("an unknown version");
  });
});
