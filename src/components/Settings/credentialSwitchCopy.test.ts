import { describe, it, expect } from "vitest";
import {
  needsSwitchConfirm,
  switchConfirmCopy,
  switchProgressLabel,
  switchResultSummary,
  trustedSavedCount,
} from "./credentialSwitchCopy";

describe("switchConfirmCopy (#5629)", () => {
  it("names the source the passwords are deleted from", () => {
    expect(switchConfirmCopy("master_password", "none").text).toContain(
      "your master-password vault"
    );
    expect(switchConfirmCopy("os_keychain", "none").text).toContain("the OS Keychain");
  });

  it("names how many passwords a switch touches when the count is known (#5837)", () => {
    expect(switchConfirmCopy("master_password", "none", 2).text).toContain(
      "deletes the 2 saved passwords in your master-password vault"
    );
    expect(switchConfirmCopy("master_password", "os_keychain", 1).title).toBe(
      "Move 1 saved password to the OS Keychain?"
    );
    expect(switchConfirmCopy("os_keychain", "master_password", 4).title).toBe(
      "Move 4 saved passwords to a master-password vault"
    );
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
        for (const count of [null, 0, 3]) {
          const copy = switchConfirmCopy(from, to, count);
          expect(copy.action).not.toBe("Confirm");
          expect(`${copy.title} ${copy.text}`).not.toMatch(/credential store/i);
        }
      }
    }
  });
});

describe("trustedSavedCount (#5837)", () => {
  it("is 0 without storage and the count otherwise", () => {
    expect(trustedSavedCount("none", undefined)).toBe(0);
    expect(trustedSavedCount("master_password", 0)).toBe(0);
    expect(trustedSavedCount("master_password", 5)).toBe(5);
    expect(trustedSavedCount("os_keychain", 2)).toBe(2);
  });

  it("treats an empty OS Keychain index and odd answers as unknown", () => {
    expect(trustedSavedCount("os_keychain", 0)).toBeNull();
    expect(trustedSavedCount("master_password", undefined)).toBeNull();
    expect(trustedSavedCount("master_password", -1)).toBeNull();
    expect(trustedSavedCount("master_password", 1.5)).toBeNull();
  });
});

describe("needsSwitchConfirm (#5837)", () => {
  it("asks when passwords would move or be deleted, or the count is unknown", () => {
    expect(needsSwitchConfirm("master_password", "none", 1)).toBe(true);
    expect(needsSwitchConfirm("master_password", "os_keychain", 3)).toBe(true);
    expect(needsSwitchConfirm("os_keychain", "none", null)).toBe(true);
  });

  it("switches at once when nothing is saved", () => {
    expect(needsSwitchConfirm("none", "os_keychain", 0)).toBe(false);
    expect(needsSwitchConfirm("master_password", "none", 0)).toBe(false);
    expect(needsSwitchConfirm("master_password", "os_keychain", 0)).toBe(false);
  });

  it("leaves a master password to its setup form", () => {
    expect(needsSwitchConfirm("os_keychain", "master_password", 3)).toBe(false);
  });
});

describe("switchProgressLabel (#5837)", () => {
  it("says what the running switch does", () => {
    expect(switchProgressLabel("master_password", "os_keychain", 1)).toBe("Moving 1 password…");
    expect(switchProgressLabel("master_password", "none", 2)).toBe("Deleting 2 passwords…");
    expect(switchProgressLabel("os_keychain", "none", null)).toBe("Deleting saved passwords…");
    expect(switchProgressLabel("none", "os_keychain", 0)).toBe("Switching…");
  });
});

describe("switchResultSummary (#5837)", () => {
  const base = {
    status: "success" as const,
    migratedCount: 0,
    removedCount: 0,
    failedCount: 0,
    warnings: [],
    remaining: [],
    rolledBack: false,
  };

  it("uses the option cards' words, never internal names or 'migrated'", () => {
    const texts = [
      switchResultSummary({
        ...base,
        removedCount: 1,
        targetMode: "none",
        previousMode: "os_keychain",
      }),
      switchResultSummary({
        ...base,
        migratedCount: 2,
        targetMode: "os_keychain",
        previousMode: "master_password",
      }),
      switchResultSummary({ ...base, targetMode: "master_password", previousMode: "none" }),
    ];
    expect(texts).toEqual([
      "Stopped saving passwords. 1 saved password removed.",
      "Moved 2 saved passwords to the OS Keychain. Your master-password vault is kept.",
      "Passwords are now saved in your master-password vault.",
    ]);
    for (const text of texts) expect(text).not.toMatch(/migrat|None|Switched to/);
  });
});
