import { describe, it, expect } from "vitest";
import type { ShellEntry } from "@/types/connection";
import {
  addEntry,
  createEntry,
  defaultShellIntegrationSettings,
  removeEntry,
  reorderEntries,
  updateEntry,
} from "./shellIntegrationEntries";

function entry(id: string, name: string): ShellEntry {
  return {
    id,
    name,
    visibility: "always",
    showFor: { folders: true, files: false, folderBackground: false },
  };
}

describe("shellIntegrationEntries", () => {
  it("defaultShellIntegrationSettings mirrors the backend defaults", () => {
    const si = defaultShellIntegrationSettings();
    expect(si.entries).toEqual([]);
    expect(si.fallback).toBe("picker");
    expect(si.openInNewWindow).toBe(false);
    expect(si.registered).toBe(false);
    expect(si.firstLaunchBannerDismissed).toBe(false);
    expect(si.linuxFileManagers).toEqual({ nautilus: false, kde: false, thunar: false });
  });

  it("createEntry produces a folders-only, always-visible picker entry with a unique id", () => {
    const a = createEntry();
    const b = createEntry();
    expect(a.id).not.toBe(b.id);
    expect(a.connectionId).toBeUndefined();
    expect(a.visibility).toBe("always");
    expect(a.showFor).toEqual({ folders: true, files: false, folderBackground: false });
  });

  it("addEntry appends without mutating the input", () => {
    const list = [entry("1", "One")];
    const next = addEntry(list, entry("2", "Two"));
    expect(next.map((e) => e.id)).toEqual(["1", "2"]);
    expect(list).toHaveLength(1);
  });

  it("updateEntry replaces the matching entry by id", () => {
    const list = [entry("1", "One"), entry("2", "Two")];
    const next = updateEntry(list, { ...entry("2", "Renamed"), visibility: "extended" });
    expect(next[1].name).toBe("Renamed");
    expect(next[1].visibility).toBe("extended");
    expect(next[0]).toBe(list[0]);
  });

  it("removeEntry drops the matching entry by id", () => {
    const list = [entry("1", "One"), entry("2", "Two")];
    expect(removeEntry(list, "1").map((e) => e.id)).toEqual(["2"]);
  });

  it("reorderEntries moves an entry from one index to another", () => {
    const list = [entry("1", "One"), entry("2", "Two"), entry("3", "Three")];
    expect(reorderEntries(list, 0, 2).map((e) => e.id)).toEqual(["2", "3", "1"]);
    expect(reorderEntries(list, 2, 0).map((e) => e.id)).toEqual(["3", "1", "2"]);
  });

  it("reorderEntries returns the original list for out-of-range or no-op moves", () => {
    const list = [entry("1", "One"), entry("2", "Two")];
    expect(reorderEntries(list, 0, 0)).toBe(list);
    expect(reorderEntries(list, -1, 1)).toBe(list);
    expect(reorderEntries(list, 0, 5)).toBe(list);
  });
});
