import { useMemo, useState } from "react";

/**
 * Decides whether a single item matches a search query. The query is already
 * normalized (trimmed + lower-cased) by {@link useListFilter}, so a matcher only
 * has to do case-insensitive substring checks. An empty query must match
 * everything.
 */
export type ListFilterMatcher<T> = (item: T, normalizedQuery: string) => boolean;

/** An item that carries the standard `name` / `description` / `tags` fields. */
export interface NameDescriptionTagsItem {
  name: string;
  description?: string;
  tags: string[];
}

/**
 * The default flat-sidebar matcher: matches `name`, `description`, or any `tag`
 * against the (already lower-cased) query via case-insensitive substring. Shared
 * by the Macro and Workflow managers, which previously each re-implemented this
 * exact predicate inline (UISF-020). Mirrors the shape of the tree-sidebar
 * matchers in `utils/connectionSearch.ts` / `utils/agentTreeSearch.ts`.
 */
export function nameDescriptionTagsMatcher<T extends NameDescriptionTagsItem>(
  item: T,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  if (item.name.toLowerCase().includes(normalizedQuery)) return true;
  if (item.description?.toLowerCase().includes(normalizedQuery)) return true;
  return item.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
}

/** State + derived list returned by {@link useListFilter}. */
export interface ListFilter<T> {
  /** Raw query text bound to the search input. */
  query: string;
  /** Update the query (wired to the search input's `onChange`). */
  setQuery: (query: string) => void;
  /** Items retained by `matcher` for the current (normalized) query. */
  filtered: T[];
}

/**
 * Search-query state plus the filtered list for a flat sidebar. Encapsulates the
 * `query` useState and the `items.filter(matcher(normalized))` memo that the
 * Macro, Workflow, and Recent Sessions sidebars each duplicated inline
 * (UISF-020). The query is normalized (trimmed + lower-cased) once before being
 * handed to `matcher`.
 *
 * Pass a **stable** matcher reference (a module-level function such as
 * {@link nameDescriptionTagsMatcher}, or a `useCallback`) so the memo only
 * recomputes when `items` or `query` change.
 */
export function useListFilter<T>(items: T[], matcher: ListFilterMatcher<T>): ListFilter<T> {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => matcher(item, normalized));
  }, [items, query, matcher]);
  return { query, setQuery, filtered };
}
