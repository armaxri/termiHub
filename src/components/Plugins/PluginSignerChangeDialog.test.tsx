/**
 * Tests for the publisher-key-change confirmation copy (#3489): each risky
 * transition explains what changed and why it matters.
 */
import { describe, it, expect } from "vitest";
import type { PluginSignerChange } from "@/types/plugin";
import { signerChangeCopy } from "./PluginSignerChangeDialog";

function change(overrides: Partial<PluginSignerChange>): PluginSignerChange {
  return {
    pluginId: "acme",
    pluginName: "Acme",
    installedKeyId: "sha256:aa",
    incomingKeyId: "sha256:bb",
    kind: "keyChanged",
    ...overrides,
  };
}

describe("signerChangeCopy (#3489)", () => {
  it("says the publisher key changed and asks the user to verify it", () => {
    const copy = signerChangeCopy(change({}));
    expect(copy.title).toBe("The publisher key of Acme changed");
    expect(copy.message).toContain("signed by a different key");
    expect(copy.message).toContain("compromised");
    expect(copy.confirmLabel).toBe("Replace with new key");
  });

  it("words a removed signature strongly", () => {
    const copy = signerChangeCopy(change({ kind: "signatureRemoved", incomingKeyId: null }));
    expect(copy.title).toBe("Acme is no longer signed");
    expect(copy.message).toContain("carries no signature at all");
    expect(copy.message).toContain("Do not continue");
    expect(copy.confirmLabel).toBe("Replace with unsigned package");
  });

  it("is conservative when the installed signer is unknown", () => {
    const copy = signerChangeCopy(change({ kind: "unverifiable", installedKeyId: null }));
    expect(copy.title).toBe("Cannot verify the publisher of Acme");
    expect(copy.message).toContain("could not determine which key signed");
  });
});
