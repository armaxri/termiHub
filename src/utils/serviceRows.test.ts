import { describe, expect, it } from "vitest";
import type { ServiceHealth, ServiceKind, ServiceModel } from "./serviceModel";
import { serviceRowKey, serviceRows, type ServiceEntry, type ServiceRow } from "./serviceRows";

interface Over {
  kind?: ServiceKind;
  health?: ServiceHealth;
  parent?: string;
  /** Its agent, which is offline. */
  away?: string;
  texts?: string[];
  model?: Partial<ServiceModel>;
}

function entry(id: string, over: Over = {}): ServiceEntry {
  const { kind = "tunnel", health = "quiet", parent, away, texts = [], model } = over;
  return {
    model: {
      id,
      kind,
      name: `name ${id}`,
      what: "Reach db through Build Box",
      technical: "Local",
      health,
      where: away ? { label: `agent ${away}`, agentId: away, name: `Agent ${away}` } : {},
      nextSteps: away ? [{ id: "connectAgent", label: "Connect agent" }] : [],
      ...model,
    } as ServiceModel,
    parentId: parent,
    texts,
  };
}

const show = (rows: ServiceRow[]) =>
  rows.map((row) => {
    switch (row.type) {
      case "group":
        return `${row.kind} ${row.shown === undefined ? "" : `${row.shown} of `}${row.models.length}${row.open ? "" : " closed"}`;
      case "agent":
        return `agent ${row.name} ${row.models.length}`;
      case "service":
        return `${row.underAgent ? "> " : ""}${row.entry.model.id}`;
    }
  });

function rows(entries: ServiceEntry[], over: Partial<Parameters<typeof serviceRows>[0]> = {}) {
  return show(serviceRows({ entries, query: "", only: null, closed: new Set(), ...over }));
}

describe("the groups", () => {
  it("come in one order, each with its numbers, and only when they have rows", () => {
    const web = entry("web", { kind: "fileServer", health: "running" });
    expect(rows([web, entry("a", { health: "running" }), entry("b")])).toEqual([
      "tunnel 2",
      "a",
      "b",
      "fileServer 1",
      "web",
    ]);
    expect(rows([web])).toEqual(["fileServer 1", "web"]);
    expect(rows([])).toEqual([]);
  });

  it("can be closed, and open for what was asked for", () => {
    const entries = [entry("a", { health: "error" }), entry("b")];
    const closed = new Set(["tunnel"]);
    expect(rows(entries, { closed })).toEqual(["tunnel 2 closed"]);
    expect(rows(entries, { closed, query: "name b" })).toEqual(["tunnel 1 of 2", "b"]);
    expect(rows(entries, { closed, only: "error" })).toEqual(["tunnel 1 of 2", "a"]);
  });
});

describe("the order", () => {
  const entries = [
    entry("ok", { health: "running" }),
    entry("wait", { health: "waiting" }),
    entry("doubt", { health: "notKnown" }),
    entry("again", { health: "reconnecting" }),
    entry("bad", { health: "error" }),
  ];

  it("has what needs the user first, each part by name", () => {
    const step = { nextSteps: [{ id: "unlock" as const, label: "Unlock" }] };
    const all = [...entries, entry("locked", { health: "waiting", model: step })];
    expect(rows(all)).toEqual(["tunnel 6", "bad", "doubt", "locked", "again", "ok", "wait"]);
  });

  it("sorts numbers in names as numbers", () => {
    const some = ["Build 10", "build 2"].map((name) => entry(name, { model: { name } }));
    expect(rows(some)).toEqual(["tunnel 2", "build 2", "Build 10"]);
  });

  it("does not change under the pointer, and takes new rows at the end", () => {
    const held = ["group tunnel", "wait", "bad", "doubt", "ok", "again"];
    const added = [entry("new", { health: "error" }), ...entries];
    expect(rows(added, { held })).toEqual([
      "tunnel 6",
      "wait",
      "bad",
      "doubt",
      "ok",
      "again",
      "new",
    ]);
  });

  it("keeps a chained pair together, first when either half needs a look", () => {
    const pair = [
      entry("ok"),
      entry("parent"),
      entry("hop", { parent: "parent", health: "error" }),
    ];
    expect(rows(pair)).toEqual(["tunnel 3", "parent", "hop", "ok"]);
    expect(rows(pair, { only: "error" })).toEqual(["tunnel 2 of 3", "parent", "hop"]);
  });
});

describe("an offline agent", () => {
  it("gets one line when it has several services here", () => {
    const entries = [
      entry("a", { away: "x", health: "notKnown" }),
      entry("mid", { health: "running" }),
      entry("b", { away: "x", health: "waiting" }),
      entry("lone", { away: "y", health: "notKnown" }),
    ];
    expect(rows(entries)).toEqual(["agent Agent x 2", "> a", "> b", "tunnel 2", "lone", "mid"]);
  });

  it("has the services of both kinds under that line", () => {
    const entries = [
      entry("a", { away: "x", health: "error" }),
      entry("other", { health: "error" }),
      entry("s", { away: "x", kind: "fileServer" }),
    ];
    expect(rows(entries)).toEqual(["agent Agent x 2", "> a", "> s", "tunnel 1", "other"]);
    expect(rows(entries, { only: "error" })).toEqual([
      "agent Agent x 2",
      "> a",
      "tunnel 1 of 1",
      "other",
    ]);
  });

  it("does not take the hop, which runs on this computer", () => {
    const entries = [
      entry("p", { away: "x" }),
      entry("hop", { parent: "p" }),
      entry("q", { away: "x" }),
    ];
    expect(rows(entries)).toEqual(["agent Agent x 3", "> p", "hop", "> q"]);
  });
});

describe("the search", () => {
  const entries = [
    entry("a", { texts: ["shop-web", "15432"], model: { description: "The wiki" } }),
    entry("b", { model: { technical: "Dynamic", machine: "Edge box" } }),
    entry("c", { kind: "fileServer", model: { address: { copy: "http://x:8080" } as never } }),
  ];
  it.each([
    ["shop-web", ["a"]],
    ["15432", ["a"]],
    ["WIKI", ["a"]],
    ["dynamic", ["b"]],
    ["edge", ["b"]],
    ["8080", ["c"]],
    ["name c", ["c"]],
    ["  ", ["a", "b", "c"]],
    ["nothing like it", []],
  ])("%j finds %j", (query, found) => {
    const shown = rows(entries, { query }).filter((row) => !/^(tunnel|fileServer) /.test(row));
    expect(shown).toEqual(found);
  });

  it("looks at the state, too", () => {
    const some = [entry("a", { model: { stateLabel: "Error" } }), entry("b")];
    expect(rows(some, { query: "error" })).toEqual(["tunnel 1 of 2", "a"]);
  });

  it("does not change the numbers of a group", () => {
    const some = [entry("a", { health: "running" }), entry("b", { health: "running" })];
    expect(rows(some, { query: "name b" })).toEqual(["tunnel 1 of 2", "b"]);
  });

  it("goes with a number", () => {
    const some = [entry("a", { health: "error" }), entry("b", { health: "error" }), entry("c")];
    expect(rows(some, { only: "error", query: "name b" })).toEqual(["tunnel 1 of 3", "b"]);
  });
});

it("a number that is gone shows all rows again", () => {
  expect(rows([entry("a"), entry("b")], { only: "error" })).toEqual(["tunnel 2", "a", "b"]);
});

it("every row has its own key", () => {
  const entries = [
    entry("a", { away: "x" }),
    entry("b", { away: "x" }),
    entry("c", { away: "x", kind: "fileServer" }),
    entry("d", { away: "x", kind: "fileServer" }),
  ];
  const keys = serviceRows({ entries, query: "", only: null, closed: new Set() }).map(
    serviceRowKey
  );
  expect(new Set(keys).size).toBe(5);
});
