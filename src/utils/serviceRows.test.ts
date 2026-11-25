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
        return `${row.kind} ${row.running}/${row.total}${row.open ? "" : " closed"}`;
      case "agent":
        return `agent ${row.name} (${row.services})`;
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
      "tunnel 1/2",
      "a",
      "b",
      "fileServer 1/1",
      "web",
    ]);
    expect(rows([web])).toEqual(["fileServer 1/1", "web"]);
    expect(rows([])).toEqual([]);
  });

  it("can be closed, and open for what was asked for", () => {
    const entries = [entry("a", { health: "error" }), entry("b")];
    const closed = new Set<ServiceKind>(["tunnel"]);
    expect(rows(entries, { closed })).toEqual(["tunnel 0/2 closed"]);
    expect(rows(entries, { closed, query: "name b" })).toEqual(["tunnel 0/2", "b"]);
    expect(rows(entries, { closed, only: "error" })).toEqual(["tunnel 0/2", "a"]);
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

  it("has what needs a look first, else the saved order", () => {
    expect(rows(entries)).toEqual(["tunnel 1/5", "doubt", "bad", "ok", "wait", "again"]);
  });

  it("does not change under the pointer, and takes new rows at the end", () => {
    const held = ["group tunnel", "wait", "bad", "doubt", "ok", "again"];
    const added = [entry("new", { health: "error" }), ...entries];
    expect(rows(added, { held })).toEqual([
      "tunnel 1/6",
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
    expect(rows(pair)).toEqual(["tunnel 0/3", "parent", "hop", "ok"]);
    expect(rows(pair, { only: "error" })).toEqual(["tunnel 0/3", "parent", "hop"]);
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
    expect(rows(entries)).toEqual(["tunnel 1/4", "agent Agent x (2)", "> a", "> b", "lone", "mid"]);
  });

  it("is counted in each group by itself", () => {
    const entries = [entry("a", { away: "x" }), entry("s", { away: "x", kind: "fileServer" })];
    expect(rows(entries)).toEqual(["tunnel 0/1", "a", "fileServer 0/1", "s"]);
  });

  it("does not take the hop, which runs on this computer", () => {
    const entries = [
      entry("p", { away: "x" }),
      entry("hop", { parent: "p" }),
      entry("q", { away: "x" }),
    ];
    expect(rows(entries)).toEqual(["tunnel 0/3", "agent Agent x (2)", "> p", "hop", "> q"]);
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
    const shown = rows(entries, { query }).filter((row) => !row.includes("/"));
    expect(shown).toEqual(found);
  });

  it("goes with a number", () => {
    const some = [entry("a", { health: "error" }), entry("b", { health: "error" }), entry("c")];
    expect(rows(some, { only: "error", query: "name b" })).toEqual(["tunnel 0/3", "b"]);
  });
});

it("a number that is gone shows all rows again", () => {
  expect(rows([entry("a"), entry("b")], { only: "error" })).toEqual(["tunnel 0/2", "a", "b"]);
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
  expect(new Set(keys).size).toBe(8);
});
