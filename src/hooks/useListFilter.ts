import { useMemo, useState } from "react";
import { textFieldsMatchQuery } from "@/utils/searchMatching";

/**
 * Lists the searchable text of a single item (e.g. its name, description and
 * tags). `null`/`undefined` entries are skipped, so optional fields can be
 * passed as-is. {@link useListFilter} matches the query against these through
 * the shared {@link textFieldsMatchQuery}: substring semantics, case- and
 * diacritic-insensitive (`muller` finds `Müller`), the same as the sidebar tree
 * search (#4372).
 */
export type ListFilterFields<T> = (item: T) => ReadonlyArray<string | null | undefined>;

/** An item that carries the standard `name` / `description` / `tags` fields. */
export interface NameDescriptionTagsItem {
  name: string;
  description?: string;
  tags: string[];
}

/**
 * The default flat-sidebar fields: `name`, `description`, and every `tag`.
 * Shared by the Macro and Workflow managers, which previously each
 * re-implemented this predicate inline (UISF-020).
 */
export function nameDescriptionTagsFields<T extends NameDescriptionTagsItem>(
  item: T
): ReadonlyArray<string | undefined> {
  return [item.name, item.description, ...item.tags];
}

/**
 * Whether `item` matches the (trimmed) query on any of the fields `getFields`
 * lists. An empty query matches everything. Exposed for filters that keep their
 * own query state (e.g. a combobox whose input value is also its submit value).
 */
export function itemMatchesQuery<T>(
  item: T,
  getFields: ListFilterFields<T>,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  const fields = getFields(item).filter((f): f is string => typeof f === "string" && f !== "");
  return textFieldsMatchQuery(fields, normalizedQuery);
}

/** State + derived list returned by {@link useListFilter}. */
export interface ListFilter<T> {
  /** Raw query text bound to the search input. */
  query: string;
  /** Update the query (wired to the search input's `onChange`). */
  setQuery: (query: string) => void;
  /** Items with at least one field matching the current (trimmed) query. */
  filtered: T[];
}

/**
 * Search-query state plus the filtered list for a flat list or picker.
 * Encapsulates the `query` useState and the filter memo that the Macro,
 * Workflow, and Recent Sessions sidebars each duplicated inline (UISF-020), and
 * delegates matching to the shared {@link textFieldsMatchQuery} (#4372).
 *
 * Pass a **stable** `getFields` reference (a module-level function such as
 * {@link nameDescriptionTagsFields}, or a `useCallback`) so the memo only
 * recomputes when `items` or `query` change.
 */
export function useListFilter<T>(items: T[], getFields: ListFilterFields<T>): ListFilter<T> {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim();
    if (!normalized) return items;
    return items.filter((item) => itemMatchesQuery(item, getFields, normalized));
  }, [items, query, getFields]);
  return { query, setQuery, filtered };
}
