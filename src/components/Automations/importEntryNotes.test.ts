import { describe, expect, it } from "vitest";
import type { ImportedEntry } from "@/services/automationFileIo";
import type { Automation } from "@/types/generated/Automation";
import { importEntryNotes } from "./AutomationImportDialog";

function entry(over: Partial<ImportedEntry> = {}): ImportedEntry {
  return {
    automation: { id: "a", name: "Helper" } as Automation,
    leftOut: [],
    triggersOff: [],
    localProcess: true,
    removedScriptPaths: [],
    outside: [],
    ...over,
  };
}

describe("importEntryNotes: a local program (live product run, #5518)", () => {
  it("points at the experimental switch while it is off", () => {
    expect(importEntryNotes(entry(), { experimental: false, localPrograms: false })).toEqual([
      "Runs a program on this computer: not until you turn on Settings ▸ General ▸ Allow experimental features and allow the program.",
    ]);
  });

  it("points at the local-programs switch once experimental features are on", () => {
    const [note] = importEntryNotes(entry(), { experimental: true, localPrograms: false });
    expect(note).toBe(
      "Runs a program on this computer: not until you turn on Settings ▸ Security ▸ Allow automations to run local programs."
    );
  });

  it("does not send the user to switches that are already on", () => {
    const [note] = importEntryNotes(entry(), { experimental: true, localPrograms: true });
    expect(note).toBe(
      "Runs a program on this computer: termiHub asks you before it runs the program."
    );
    expect(note).not.toContain("turn on");
  });

  it("says nothing about programs for an automation without one", () => {
    expect(
      importEntryNotes(entry({ localProcess: false }), {
        experimental: false,
        localPrograms: false,
      })
    ).toEqual([]);
  });
});
