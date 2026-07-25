import { describe, it, expect } from "vitest";
import { resolveRestoreMode, summarizeLastSession } from "./restoreMode";
import type { AppSettings } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";

function settings(partial: Partial<AppSettings>): AppSettings {
  return { version: "1", externalConnectionFiles: [], ...partial } as AppSettings;
}

describe("resolveRestoreMode", () => {
  it("returns the explicit mode when set", () => {
    expect(resolveRestoreMode(settings({ restoreLastSessionMode: "never" }))).toBe("never");
    expect(resolveRestoreMode(settings({ restoreLastSessionMode: "ask" }))).toBe("ask");
    expect(resolveRestoreMode(settings({ restoreLastSessionMode: "always" }))).toBe("always");
  });

  it("prefers the explicit mode over the legacy boolean", () => {
    expect(
      resolveRestoreMode(
        settings({ restoreLastSessionMode: "always", restoreLastSessionOnStartup: false })
      )
    ).toBe("always");
  });

  it("migrates the legacy boolean false to never", () => {
    expect(resolveRestoreMode(settings({ restoreLastSessionOnStartup: false }))).toBe("never");
  });

  it("defaults to ask when nothing is set", () => {
    expect(resolveRestoreMode(settings({}))).toBe("ask");
  });

  it("defaults to ask when the legacy boolean is true", () => {
    expect(resolveRestoreMode(settings({ restoreLastSessionOnStartup: true }))).toBe("ask");
  });

  it("falls through to ask for an out-of-range mode value", () => {
    expect(resolveRestoreMode(settings({ restoreLastSessionMode: "bogus" as "ask" }))).toBe("ask");
  });
});

describe("summarizeLastSession", () => {
  const session: LastSession = {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Group",
        layout: {
          type: "split",
          direction: "horizontal",
          children: [
            {
              type: "leaf",
              tabs: [
                { title: "prod-db", inlineConfig: { type: "ssh", config: { host: "prod-db" } } },
                { inlineConfig: { type: "serial", config: { device: "/dev/ttyUSB0" } } },
              ],
            },
            {
              type: "leaf",
              tabs: [{ inlineConfig: { type: "local", config: { shell: "bash" } } }],
            },
          ],
        },
      },
    ],
  };

  it("counts every tab across nested leaves", () => {
    expect(summarizeLastSession(session).tabCount).toBe(3);
  });

  it("uses the title override and derives type labels", () => {
    const { tabs } = summarizeLastSession(session);
    expect(tabs[0]).toEqual({ title: "prod-db", typeLabel: "SSH" });
    // No title: falls back to the device path, Serial type badge.
    expect(tabs[1]).toEqual({ title: "/dev/ttyUSB0", typeLabel: "Serial" });
    expect(tabs[2]).toEqual({ title: "Local", typeLabel: "Local" });
  });

  it("reports zero tabs for an empty session", () => {
    const empty: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [{ name: "Empty", layout: { type: "leaf", tabs: [] } }],
    };
    expect(summarizeLastSession(empty)).toEqual({ tabCount: 0, tabs: [] });
  });
});
