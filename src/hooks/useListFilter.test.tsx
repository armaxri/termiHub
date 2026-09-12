import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  useListFilter,
  nameDescriptionTagsMatcher,
  ListFilter,
  ListFilterMatcher,
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
  matcher,
  onResult,
}: {
  items: Item[];
  matcher: ListFilterMatcher<Item>;
  onResult: (r: ListFilter<Item>) => void;
}) {
  onResult(useListFilter(items, matcher));
  return null;
}

describe("useListFilter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ListFilter<Item>;

  function render(items: Item[], matcher: ListFilterMatcher<Item> = nameDescriptionTagsMatcher) {
    act(() => {
      root.render(createElement(Harness, { items, matcher, onResult: (r) => (latest = r) }));
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

  it("trims and lower-cases the query before matching", () => {
    render(ITEMS);
    act(() => latest.setQuery("  BACKUP  "));
    expect(latest.filtered.map((i) => i.name)).toEqual(["Backup"]);
  });

  it("uses a caller-supplied matcher", () => {
    const nameOnly: ListFilterMatcher<Item> = (item, q) =>
      !q || item.name.toLowerCase().includes(q);
    render(ITEMS, nameOnly);
    // "nightly" only appears in a description, so the name-only matcher excludes it.
    act(() => latest.setQuery("nightly"));
    expect(latest.filtered).toHaveLength(0);
  });
});

describe("nameDescriptionTagsMatcher", () => {
  const item: Item = { name: "Alpha", description: "beta", tags: ["gamma"] };

  it("matches everything on an empty query", () => {
    expect(nameDescriptionTagsMatcher(item, "")).toBe(true);
  });

  it("matches name, description, and tags", () => {
    expect(nameDescriptionTagsMatcher(item, "alph")).toBe(true);
    expect(nameDescriptionTagsMatcher(item, "beta")).toBe(true);
    expect(nameDescriptionTagsMatcher(item, "gamma")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(nameDescriptionTagsMatcher(item, "delta")).toBe(false);
  });

  it("tolerates a missing description", () => {
    expect(nameDescriptionTagsMatcher({ name: "x", tags: [] }, "y")).toBe(false);
  });
});
