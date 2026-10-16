import { describe, it, expect } from "vitest";
import type { ConnectionFolder, MobaxtermSession, SavedConnection } from "@/types/connection";
import {
  buildMobaxtermImportPlan,
  folderLabel,
  folderPathId,
  isImportable,
} from "./mobaxtermImport";

function session(overrides: Partial<MobaxtermSession>): MobaxtermSession {
  return {
    key: "moba-0",
    name: "Lab router",
    folderPath: [],
    sessionType: "SSH",
    target: "netops@10.0.0.1",
    connectionType: "ssh",
    settings: { host: "10.0.0.1", port: 22, username: "netops", authMethod: "password" },
    notes: [],
    ...overrides,
  };
}

const SKIPPED = session({
  key: "moba-9",
  name: "Docs",
  sessionType: "Browser",
  connectionType: undefined,
  settings: undefined,
  skipReason: "termiHub has no Browser connection type.",
});

describe("isImportable", () => {
  it("accepts sessions with a type and settings and rejects skipped ones", () => {
    expect(isImportable(session({}))).toBe(true);
    expect(isImportable(SKIPPED)).toBe(false);
  });
});

describe("folderPathId", () => {
  it("mirrors the backend path-based folder id", () => {
    expect(folderPathId(null, "Lab")).toBe("Lab");
    expect(folderPathId("Lab", "Switches")).toBe("Lab/Switches");
    expect(folderPathId(null, "a/b 100%")).toBe("a%2Fb 100%25");
  });
});

describe("folderLabel", () => {
  it("joins levels and is empty for the root", () => {
    expect(folderLabel(["Lab", "Switches"])).toBe("Lab / Switches");
    expect(folderLabel([])).toBe("");
  });
});

describe("buildMobaxtermImportPlan", () => {
  it("creates connections at the target root with their settings and type", () => {
    const plan = buildMobaxtermImportPlan([session({})], null, [], []);
    expect(plan.folders).toEqual([]);
    expect(plan.connections).toHaveLength(1);
    const [conn] = plan.connections;
    expect(conn.name).toBe("Lab router");
    expect(conn.folderId).toBeNull();
    expect(conn.config).toEqual({
      type: "ssh",
      config: { host: "10.0.0.1", port: 22, username: "netops", authMethod: "password" },
    });
  });

  it("recreates nested folders once, parents first, under the target folder", () => {
    const target: ConnectionFolder = {
      id: "Imported",
      name: "Imported",
      parentId: null,
      isExpanded: true,
    };
    const plan = buildMobaxtermImportPlan(
      [
        session({ key: "a", name: "sw1", folderPath: ["Lab", "Switches"] }),
        session({ key: "b", name: "sw2", folderPath: ["Lab", "Switches"] }),
        session({ key: "c", name: "srv", folderPath: ["Lab"] }),
      ],
      "Imported",
      [target],
      []
    );
    expect(plan.folders.map((f) => [f.id, f.parentId])).toEqual([
      ["Imported/Lab", "Imported"],
      ["Imported/Lab/Switches", "Imported/Lab"],
    ]);
    expect(plan.connections.map((c) => c.folderId)).toEqual([
      "Imported/Lab/Switches",
      "Imported/Lab/Switches",
      "Imported/Lab",
    ]);
  });

  it("reuses an existing folder with the same name and parent", () => {
    const existing: ConnectionFolder = {
      id: "Lab",
      name: "Lab",
      parentId: null,
      isExpanded: false,
    };
    const plan = buildMobaxtermImportPlan([session({ folderPath: ["Lab"] })], null, [existing], []);
    expect(plan.folders).toEqual([]);
    expect(plan.connections[0].folderId).toBe("Lab");
  });

  it("makes names unique per folder against existing and same-batch names", () => {
    const existing: SavedConnection[] = [
      { id: "Lab router", name: "Lab router", folderId: null, config: { type: "ssh", config: {} } },
    ];
    const plan = buildMobaxtermImportPlan(
      [
        session({ key: "a" }),
        session({ key: "b" }),
        session({ key: "c", folderPath: ["Elsewhere"] }),
      ],
      null,
      [],
      existing
    );
    expect(plan.connections.map((c) => c.name)).toEqual([
      "Lab router (2)",
      "Lab router (3)",
      "Lab router",
    ]);
  });

  it("ignores skipped sessions and gives every connection a distinct id", () => {
    const plan = buildMobaxtermImportPlan(
      [session({ key: "a" }), SKIPPED, session({ key: "b", name: "Other" })],
      null,
      [],
      []
    );
    expect(plan.connections.map((c) => c.name)).toEqual(["Lab router", "Other"]);
    expect(new Set(plan.connections.map((c) => c.id)).size).toBe(2);
  });

  it("copies settings so the plan does not alias the preview", () => {
    const s = session({});
    const plan = buildMobaxtermImportPlan([s], null, [], []);
    expect(plan.connections[0].config.config).not.toBe(s.settings);
  });
});
