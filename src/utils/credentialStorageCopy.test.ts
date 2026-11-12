import { describe, it, expect } from "vitest";
import type { SettingsField } from "@/types/schema";
import {
  CREDENTIAL_STORAGE_CHOICES,
  CREDENTIAL_STORAGE_CHOOSE_TEXT,
  CREDENTIAL_STORAGE_OFF_TEXT,
  credentialStorageParagraph,
  modeAwareSaveHelpText,
  withModeAwareSaveHelp,
} from "./credentialStorageCopy";

const BASE = "When enabled, termiHub saves your credentials.";

describe("credentialStorageCopy (#5186)", () => {
  it("tells a None-mode user storage is off and where to enable it", () => {
    const help = modeAwareSaveHelpText(BASE, "none")!;
    expect(help.startsWith(CREDENTIAL_STORAGE_OFF_TEXT)).toBe(true);
    expect(help).toContain("Settings ▸ Security");
    expect(help).toContain(BASE);
    expect(help).not.toMatch(/master password/i);
  });

  it("names the OS keychain and never a master password in OS Keychain mode", () => {
    const help = modeAwareSaveHelpText(BASE, "os_keychain")!;
    expect(help.startsWith(BASE)).toBe(true);
    expect(help).toContain("macOS Keychain");
    expect(help).toContain("Windows Credential Manager");
    expect(help).toContain("Linux Secret Service");
    expect(help).not.toMatch(/master password/i);
  });

  it("keeps the master-password vault explanation in Master Password mode", () => {
    const help = modeAwareSaveHelpText(BASE, "master_password")!;
    expect(help.startsWith(BASE)).toBe(true);
    expect(help).toContain("protected by your master password using AES-256-GCM");
    expect(help).toContain("once per session");
  });

  it("leaves the help untouched while the mode is unknown", () => {
    expect(credentialStorageParagraph(undefined)).toBeNull();
    expect(modeAwareSaveHelpText(BASE, undefined)).toBe(BASE);
    expect(modeAwareSaveHelpText(undefined, undefined)).toBeUndefined();
  });

  it("gives a field without help text just the mode paragraph", () => {
    expect(modeAwareSaveHelpText(undefined, "none")).toBe(CREDENTIAL_STORAGE_OFF_TEXT);
  });

  it("only rewrites the savePassword field", () => {
    const other: SettingsField = {
      key: "host",
      label: "Host",
      fieldType: { type: "text" },
      required: false,
      helpText: BASE,
    } as SettingsField;
    expect(withModeAwareSaveHelp(other, "none")).toBe(other);
    const save = { ...other, key: "savePassword" } as SettingsField;
    const out = withModeAwareSaveHelp(save, "none");
    expect(out).not.toBe(save);
    expect(out.helpText).toContain("Credential storage is off");
    expect(save.helpText).toBe(BASE);
  });
});

describe("first-use storage chooser copy (#5187)", () => {
  it("says the first save asks, instead of storage being off, before any choice", () => {
    const help = modeAwareSaveHelpText(BASE, "none", true)!;
    expect(help.startsWith(CREDENTIAL_STORAGE_CHOOSE_TEXT)).toBe(true);
    expect(help).not.toContain(CREDENTIAL_STORAGE_OFF_TEXT);
    expect(help).toContain(BASE);
  });

  it("lists the OS keychain first, recommended, with sentence-case explanations", () => {
    expect(CREDENTIAL_STORAGE_CHOICES.map((c) => c.mode)).toEqual([
      "os_keychain",
      "master_password",
      "none",
    ]);
    expect(CREDENTIAL_STORAGE_CHOICES[0].badge).toBe("Recommended");
    for (const choice of CREDENTIAL_STORAGE_CHOICES) {
      expect(choice.description[0]).toBe(choice.description[0].toUpperCase());
      expect(choice.description.endsWith(".")).toBe(true);
    }
  });
});
