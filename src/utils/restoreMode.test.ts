import { describe, it, expect } from "vitest";
import { filterSessionBySelection, resolveRestoreMode, summarizeLastSession } from "./restoreMode";
import type { AppSettings, SavedConnection } from "@/types/connection";
import type { LastSession } from "@/types/lastSession";
import { countWorkspaceTabs, getWorkspaceLeaves } from "@/utils/workspaceLayout";

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
    expect(tabs[0]).toMatchObject({ title: "prod-db", typeLabel: "SSH" });
    // No title: falls back to the device path, Serial type badge.
    expect(tabs[1]).toMatchObject({ title: "/dev/ttyUSB0", typeLabel: "Serial" });
    expect(tabs[2]).toMatchObject({ title: "Local", typeLabel: "Local" });
  });

  it("derives a probe target per tab", () => {
    const { tabs } = summarizeLastSession(session);
    expect(tabs[0].target).toEqual({ kind: "host", host: "prod-db", port: 22 });
    expect(tabs[1].target).toEqual({ kind: "serial", device: "/dev/ttyUSB0" });
    expect(tabs[2].target).toEqual({ kind: "local" });
  });

  it("uses the telnet default port when unspecified", () => {
    const telnet: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        {
          name: "G",
          layout: {
            type: "leaf",
            tabs: [{ inlineConfig: { type: "telnet", config: { host: "switch" } } }],
          },
        },
      ],
    };
    expect(summarizeLastSession(telnet).tabs[0].target).toEqual({
      kind: "host",
      host: "switch",
      port: 23,
    });
  });

  it("honours an explicit host port", () => {
    const ssh: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        {
          name: "G",
          layout: {
            type: "leaf",
            tabs: [{ inlineConfig: { type: "ssh", config: { host: "h", port: 2222 } } }],
          },
        },
      ],
    };
    expect(summarizeLastSession(ssh).tabs[0].target).toEqual({
      kind: "host",
      host: "h",
      port: 2222,
    });
  });

  it("resolves a connectionRef target from the supplied connections", () => {
    const connections: SavedConnection[] = [
      {
        id: "c1",
        name: "prod",
        folderId: null,
        config: { type: "ssh", config: { host: "10.0.0.5", port: 22 } },
      } as SavedConnection,
    ];
    const refSession: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        { name: "G", layout: { type: "leaf", tabs: [{ connectionRef: "c1", title: "prod" }] } },
      ],
    };
    expect(summarizeLastSession(refSession, connections).tabs[0].target).toEqual({
      kind: "host",
      host: "10.0.0.5",
      port: 22,
    });
    // Without the connections it cannot resolve the ref → not network-probed.
    expect(summarizeLastSession(refSession).tabs[0].target).toEqual({ kind: "local" });
  });

  it("derives an agent target from an agentRef tab", () => {
    const agentSession: LastSession = {
      version: "1",
      activeGroupIndex: 0,
      tabGroups: [
        {
          name: "G",
          layout: {
            type: "leaf",
            tabs: [{ agentRef: { agentId: "a1", definitionId: "d1" } }],
          },
        },
      ],
    };
    expect(summarizeLastSession(agentSession).tabs[0].target).toEqual({
      kind: "agent",
      agentId: "a1",
    });
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

describe("filterSessionBySelection", () => {
  // Flat tab order (matching summarizeLastSession): 0 ssh, 1 serial, 2 local.
  const session: LastSession = {
    version: "1",
    activeGroupIndex: 0,
    tabGroups: [
      {
        name: "Group",
        layout: {
          type: "split",
          direction: "horizontal",
          sizes: [60, 40],
          children: [
            {
              type: "leaf",
              tabs: [
                { title: "ssh", inlineConfig: { type: "ssh", config: { host: "h" } } },
                { title: "serial", inlineConfig: { type: "serial", config: { device: "/dev/x" } } },
              ],
            },
            {
              type: "leaf",
              tabs: [{ title: "local", inlineConfig: { type: "local", config: {} } }],
            },
          ],
        },
      },
    ],
  };

  it("keeps only the selected tabs", () => {
    const filtered = filterSessionBySelection(session, new Set([0, 2]));
    const titles = filtered.tabGroups.flatMap((g) =>
      getWorkspaceLeaves(g.layout).flatMap((l) => l.tabs.map((t) => t.title))
    );
    expect(titles).toEqual(["ssh", "local"]);
  });

  it("collapses a split whose sibling leaf empties out", () => {
    // Deselect the local tab (index 2) → the second leaf empties, the split
    // collapses to the first leaf.
    const filtered = filterSessionBySelection(session, new Set([0, 1]));
    const layout = filtered.tabGroups[0].layout;
    expect(layout.type).toBe("leaf");
    expect(countWorkspaceTabs(layout)).toBe(2);
  });

  it("drops a group whose every tab was deselected", () => {
    const twoGroups: LastSession = {
      version: "1",
      activeGroupIndex: 1,
      tabGroups: [
        { name: "A", layout: { type: "leaf", tabs: [{ title: "a" }] } },
        { name: "B", layout: { type: "leaf", tabs: [{ title: "b" }] } },
      ],
    };
    // Keep only tab 0 (group A) → group B is removed, active remaps to A.
    const filtered = filterSessionBySelection(twoGroups, new Set([0]));
    expect(filtered.tabGroups.map((g) => g.name)).toEqual(["A"]);
    expect(filtered.activeGroupIndex).toBe(0);
  });

  it("yields no groups when nothing is selected", () => {
    expect(filterSessionBySelection(session, new Set()).tabGroups).toEqual([]);
  });
});
