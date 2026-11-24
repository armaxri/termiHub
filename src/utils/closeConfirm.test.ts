/**
 * The single "ask before closing a live session" choice (#5844): which closes
 * each choice asks for, how "Don't ask again" narrows it, and the fallback for
 * an unset or unknown value.
 */
import { describe, it, expect } from "vitest";
import {
  CLOSE_LIVE_SESSION_CONFIRM_CHOICES,
  closeConfirmAsks,
  closeConfirmWithout,
  resolveCloseConfirm,
  settingsAskBeforeClose,
  type CloseLiveSessionConfirm,
} from "./closeConfirm";

describe("closeConfirm", () => {
  it.each([
    ["always", true, true],
    ["shortcut", false, true],
    ["pointer", true, false],
    ["never", false, false],
  ] as const)("%s asks for pointer=%s, shortcut=%s", (choice, pointer, shortcut) => {
    expect(closeConfirmAsks(choice, "pointer")).toBe(pointer);
    expect(closeConfirmAsks(choice, "shortcut")).toBe(shortcut);
  });

  it("defaults to always when unset or unknown", () => {
    expect(resolveCloseConfirm({})).toBe("always");
    expect(resolveCloseConfirm({ closeLiveSessionConfirm: "bogus" as unknown as "never" })).toBe(
      "always"
    );
    expect(settingsAskBeforeClose({}, "shortcut")).toBe(true);
    expect(settingsAskBeforeClose({}, "pointer")).toBe(true);
  });

  it.each([
    ["always", "shortcut", "pointer"],
    ["always", "pointer", "shortcut"],
    ["shortcut", "shortcut", "never"],
    ["pointer", "pointer", "never"],
    ["shortcut", "pointer", "shortcut"],
    ["never", "pointer", "never"],
  ] as const)("Don't ask again on %s from a %s close gives %s", (choice, trigger, next) => {
    expect(closeConfirmWithout(choice, trigger)).toBe(next);
  });

  it("'Don't ask again' never re-enables a confirm and always silences its own trigger", () => {
    for (const choice of CLOSE_LIVE_SESSION_CONFIRM_CHOICES) {
      for (const trigger of ["pointer", "shortcut"] as const) {
        const next: CloseLiveSessionConfirm = closeConfirmWithout(choice, trigger);
        expect(closeConfirmAsks(next, trigger)).toBe(false);
        const other = trigger === "pointer" ? "shortcut" : "pointer";
        expect(closeConfirmAsks(next, other)).toBe(closeConfirmAsks(choice, other));
      }
    }
  });
});
