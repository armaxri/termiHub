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

describe("pickRecentConnections ranks by lastUsedAt (#5940)", () => {
  const stamped = (c: SavedConnection, lastUsedAt: number): SavedConnection => ({
    ...c,
    lastUsedAt,
  });

  it("ranks stamped connections by their own last-used time", () => {
    const conns = [stamped(ssh("a", "h1"), 100), ssh("b", "h2"), stamped(ssh("c", "h3"), 300)];
    const r = pickRecentConnections(conns, []);
    expect(ids(r)).toEqual(["c", "a", "b"]);
    expect(r.fromHistory).toBe(true);
  });

  it("keeps two connections to the same user@host apart", () => {
    // Both open admin@prod; only "staging-copy" was used last.
    const conns = [stamped(ssh("prod", "prod"), 100), stamped(ssh("staging-copy", "prod"), 900)];
    const history = [used("admin@prod", 900)];
    expect(ids(pickRecentConnections(conns, history))).toEqual(["staging-copy", "prod"]);
  });

  it("prefers the stamp over a newer history entry for the same title", () => {
    // The history entry was refreshed by a stamped twin, not by "a".
    const conns = [stamped(ssh("a", "h1"), 100), stamped(ssh("b", "h2"), 200)];
    const r = pickRecentConnections(conns, [used("admin@h1", 5_000)]);
    expect(ids(r)).toEqual(["b", "a"]);
  });

  it("does not credit an unstamped twin with its stamped twin's history", () => {
    // "twin" was never connected since #5940; "main" was, which refreshed
    // the shared admin@prod history entry.
    const conns = [ssh("twin", "prod"), ssh("other", "h2"), stamped(ssh("main", "prod"), 900)];
    const history = [used("admin@prod", 900), used("admin@h2", 500)];
    expect(ids(pickRecentConnections(conns, history))).toEqual(["main", "other", "twin"]);
  });

  it("falls back to the session history for connections without a stamp", () => {
    // A file from before #5940: nothing is stamped yet, so the old ranking holds.
    const conns = [ssh("a", "h1"), ssh("b", "h2")];
    const r = pickRecentConnections(conns, [used("admin@h2", 200)]);
    expect(ids(r)).toEqual(["b", "a"]);
    expect(r.fromHistory).toBe(true);
  });

  it("interleaves stamped and history-ranked connections by time", () => {
    const conns = [stamped(ssh("a", "h1"), 300), ssh("b", "h2"), stamped(ssh("c", "h3"), 100)];
    const r = pickRecentConnections(conns, [used("admin@h2", 200)]);
    expect(ids(r)).toEqual(["a", "b", "c"]);
  });

  it("treats a zero stamp as never used", () => {
    const r = pickRecentConnections([stamped(ssh("a", "h1"), 0), ssh("b", "h2")], []);
    expect(ids(r)).toEqual(["a", "b"]);
    expect(r.fromHistory).toBe(false);
  });
});
