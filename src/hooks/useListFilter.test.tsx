import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  useListFilter,
  nameDescriptionTagsFields,
  itemMatchesQuery,
  ListFilter,
  ListFilterFields,
} from "./useListFilter";

interface Item {
  name: string;
  description?: string;
  tags: string[];
}

const ITEMS: Item[] = [
  { name: "Deploy", description: "ship it", tags: ["prod", "release"] },
  { name: "Backup", description: "nightly dump", tags: ["cron"] },
  { name: "Cleanup", tags: ["prod"] },
];

function Harness({
  items,
  fields,
  onResult,
}: {
  items: Item[];
  fields: ListFilterFields<Item>;
  onResult: (r: ListFilter<Item>) => void;
}) {
  onResult(useListFilter(items, fields));
  return null;
}

describe("useListFilter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ListFilter<Item>;

  function render(items: Item[], fields: ListFilterFields<Item> = nameDescriptionTagsFields) {
    act(() => {
      root.render(createElement(Harness, { items, fields, onResult: (r) => (latest = r) }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("returns all items for an empty query", () => {
    render(ITEMS);
    expect(latest.filtered).toHaveLength(3);
  });

  it("matches on name (case-insensitive)", () => {
    render(ITEMS);
    act(() => latest.setQuery("DEPLOY"));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Deploy"]);
  });

  it("matches on description", () => {
    render(ITEMS);
    act(() => latest.setQuery("nightly"));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Backup"]);
  });

  it("matches on tags", () => {
    render(ITEMS);
    act(() => latest.setQuery("prod"));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Deploy", "Cleanup"]);
  });

  it("excludes non-matching items", () => {
    render(ITEMS);
    act(() => latest.setQuery("zzz"));
    expect(latest.filtered).toHaveLength(0);
  });

  it("trims the query and matches case-insensitively", () => {
    render(ITEMS);
    act(() => latest.setQuery("  BACKUP  "));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Backup"]);
  });

  it("matches diacritic-insensitively, like the sidebar tree search (#4372)", () => {
    const people: Item[] = [
      { name: "Müller Server", tags: [] },
      { name: "Café", description: "São Paulo office", tags: [] },
      { name: "Other", tags: [] },
    ];
    render(people);
    act(() => latest.setQuery("muller"));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Müller Server"]);
    act(() => latest.setQuery("sao"));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Café"]);
  });

  it("keeps substring semantics (no acronym or fuzzy matches)", () => {
    render([{ name: "Web Server", tags: [] }]);
    act(() => latest.setQuery("ws"));
    expect(latest.filtered).toHaveLength(0);
  });

  it("uses caller-supplied fields", () => {
    const nameOnly: ListFilterFields<Item> = (item) => [item.name];
    render(ITEMS, nameOnly);
    // "nightly" only appears in a description, so the name-only fields exclude it.
    act(() => latest.setQuery("nightly"));
    expect(latest.filtered).toHaveLength(0);
  });
});

describe("itemMatchesQuery with nameDescriptionTagsFields", () => {
  const item: Item = { name: "Alpha", description: "beta", tags: ["gamma"] };
  const match = (it: Item, q: string) => itemMatchesQuery(it, nameDescriptionTagsFields, q);

  it("matches everything on an empty query", () => {
    expect(match(item, "")).toBe(true);
  });

  it("matches name, description, and tags", () => {
    expect(match(item, "alph")).toBe(true);
    expect(match(item, "BETA")).toBe(true);
    expect(match(item, "gamma")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(match(item, "delta")).toBe(false);
  });

  it("tolerates a missing description", () => {
    expect(match({ name: "x", tags: [] }, "y")).toBe(false);
  });

  it("skips null and undefined fields", () => {
    expect(itemMatchesQuery(item, () => [null, undefined, "Zürich"], "zurich")).toBe(true);
    expect(itemMatchesQuery(item, () => [null, undefined], "x")).toBe(false);
  });
});
