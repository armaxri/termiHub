import { describe, expect, it } from "vitest";
import type { RestoredStart } from "@/types/backup";
import type { SectionChoice } from "@/components/Settings/BackupSectionRow";
import { startKey, startKind, startLines, startsOfChoice } from "./restoredStarts";

const entry = (over: Partial<RestoredStart> = {}): RestoredStart => ({
  section: "schedules",
  id: "s",
  name: "Nightly",
  starts: ["Daily at 02:00 on Build Box"],
  switches: ["enabled"],
  existsHere: false,
  sameHere: false,
  onHere: false,
  ...over,
});
const choice = (over: Partial<SectionChoice> = {}): SectionChoice => ({
  include: true,
  mode: "merge",
  conflicts: "skip",
  ...over,
});

describe("restored starts (#6056)", () => {
  it("names the kind and the key", () => {
    const kinds = ["schedules", "automations", "workflows", "tunnels", "embeddedServers", "x"];
    expect(kinds.map((section) => startKind({ section }))).toEqual([
      "Schedule",
      "Automation",
      "Automation",
      "Tunnel",
      "File server",
      "Entry",
    ]);
    expect(startKey(entry())).toBe("schedules-s");
  });

  it("adds the next run to the first line, only while it is ahead", () => {
    const now = new Date("2026-10-01T18:00:00Z");
    const next = entry({ nextRunAt: "2026-10-02T02:00:00Z", starts: ["Daily", "Other"] });
    const lines = startLines(next, now);
    expect(lines[0]).toMatch(/^Daily · next .*\d\d:\d\d$/);
    expect(lines[1]).toBe("Other");
    expect(startLines(next, new Date("2026-10-03T00:00:00Z"))[0]).toBe("Daily");
    expect(startLines(entry(), now)).toEqual(["Daily at 02:00 on Build Box"]);
  });

  it("writes out what would not show", () => {
    expect(startLines(entry({ starts: ["Hotkey \u202eR"] }))).toEqual(["Hotkey \\u{202e}R"]);
  });

  it.each([
    ["new, chosen", entry(), { schedules: choice() }, true],
    ["new, not chosen", entry(), { schedules: choice({ include: false }) }, false],
    ["new, no such choice", entry(), {}, false],
    ["here, keep mine", entry({ existsHere: true, onHere: true }), { schedules: choice() }, false],
    [
      "here, use backup",
      entry({ existsHere: true, onHere: true }),
      { schedules: choice({ conflicts: "overwrite" }) },
      true,
    ],
    [
      "here, replace",
      entry({ existsHere: true }),
      { schedules: choice({ mode: "replace" }) },
      true,
    ],
    [
      "here and different, something else overwritten",
      entry({ existsHere: true, onHere: true }),
      { schedules: choice(), connections: choice({ mode: "replace" }) },
      false,
    ],
    [
      "here and the same, what it uses overwritten",
      entry({ existsHere: true, onHere: true, sameHere: true }),
      { connections: choice({ conflicts: "overwrite" }) },
      true,
    ],
    [
      "here and the same, what it uses not chosen",
      entry({ existsHere: true, onHere: true, sameHere: true }),
      { connections: choice({ conflicts: "overwrite", include: false }) },
      false,
    ],
    [
      "here, the same and off, something else overwritten",
      entry({ existsHere: true, sameHere: true }),
      { schedules: choice(), connections: choice({ mode: "replace" }) },
      false,
    ],
  ])("%s", (_name, e, choices, listed) => {
    expect(startsOfChoice([e], choices as Record<string, SectionChoice>).length).toBe(
      listed ? 1 : 0
    );
  });
});
