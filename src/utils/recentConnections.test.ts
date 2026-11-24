import { describe, it, expect } from "vitest";
import type { SavedConnection } from "@/types/connection";
import type { SessionHistoryEntry } from "@/types/sessionHistory";
import { pickRecentConnections, RECENT_CONNECTION_LIMIT } from "./recentConnections";

function ssh(id: string, host: string, username = "admin"): SavedConnection {
  return {
    id,
    name: id,
    folderId: null,
    config: { type: "ssh", config: { host, username, port: 22 } },
  } as unknown as SavedConnection;
}

function used(title: string, lastUsed: number, connectionType = "ssh"): SessionHistoryEntry {
  return {
    dedupKey: `${connectionType}:${title}`,
    title,
    connectionType,
    config: { type: connectionType, config: {} },
    firstUsed: lastUsed,
    lastUsed,
    useCount: 1,
    pinned: false,
    promoted: false,
  } as unknown as SessionHistoryEntry;
}

const ids = (r: { connections: SavedConnection[] }) => r.connections.map((c) => c.id);

describe("pickRecentConnections (#5856)", () => {
  it("keeps sidebar order when nothing was opened yet", () => {
    const r = pickRecentConnections([ssh("a", "h1"), ssh("b", "h2")], []);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.fromHistory).toBe(false);
  });

  it("puts the most recently opened connections first", () => {
    const conns = [ssh("a", "h1"), ssh("b", "h2"), ssh("c", "h3")];
    const r = pickRecentConnections(conns, [used("admin@h3", 300), used("admin@h2", 200)]);
    expect(ids(r)).toEqual(["c", "b", "a"]);
    expect(r.fromHistory).toBe(true);
  });

  it("matches on type as well as title", () => {
    const r = pickRecentConnections(
      [ssh("a", "h1"), ssh("b", "h2")],
      [used("admin@h2", 100, "telnet")]
    );
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.fromHistory).toBe(false);
  });

  it("uses the newest of several entries for the same title", () => {
    const r = pickRecentConnections(
      [ssh("a", "h1"), ssh("b", "h2")],
      [used("admin@h1", 50), used("admin@h2", 100), used("admin@h1", 500)]
    );
    expect(ids(r)).toEqual(["a", "b"]);
  });

  it(`offers at most ${RECENT_CONNECTION_LIMIT}`, () => {
    const conns = Array.from({ length: 8 }, (_, i) => ssh(`c${i}`, `h${i}`));
    expect(pickRecentConnections(conns, [used("admin@h7", 9)]).connections).toHaveLength(
      RECENT_CONNECTION_LIMIT
    );
    expect(ids(pickRecentConnections(conns, [used("admin@h7", 9)]))[0]).toBe("c7");
  });

  it("returns nothing for no connections", () => {
    expect(pickRecentConnections([], [used("admin@h1", 1)]).connections).toEqual([]);
  });
});
