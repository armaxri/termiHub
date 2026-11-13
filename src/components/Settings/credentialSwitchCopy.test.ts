import { describe, it, expect } from "vitest";
import { switchConfirmCopy } from "./credentialSwitchCopy";

describe("switchConfirmCopy (#5629)", () => {
  it("names the source the credentials are deleted from", () => {
    expect(switchConfirmCopy("master_password", "none").text).toContain(
      "your master-password vault"
    );
    expect(switchConfirmCopy("os_keychain", "none").text).toContain("the OS Keychain");
  });

  it("marks only the switch to none as destructive", () => {
    expect(switchConfirmCopy("os_keychain", "none").destructive).toBe(true);
    expect(switchConfirmCopy("master_password", "os_keychain").destructive).toBe(false);
    expect(switchConfirmCopy("os_keychain", "master_password").destructive).toBe(false);
  });

  it("never labels an action with a bare Confirm or the old 'OS credential store' name", () => {
    const modes = ["none", "master_password", "os_keychain"] as const;
    for (const from of modes) {
      for (const to of modes) {
        if (from === to) continue;
        const copy = switchConfirmCopy(from, to);
        expect(copy.action).not.toBe("Confirm");
        expect(`${copy.title} ${copy.text}`).not.toMatch(/credential store/i);
      }
    }
  });
});
