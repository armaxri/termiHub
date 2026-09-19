import { matchSorter, rankings } from "match-sorter";

/**
 * Whether any of the given candidate strings matches the query.
 *
 * Backed by {@link https://github.com/kentcdodds/match-sorter | match-sorter}
 * with a `CONTAINS`-or-better threshold, so it keeps the substring semantics of
 * a plain `.includes()` check (it never adds acronym/fuzzy matches that a
 * substring search would miss) while gaining match-sorter's normalization:
 * matching is case- and diacritic-insensitive, so `"cafe"` matches `"Café"` and
 * `"sao"` matches `"São Paulo"`.
 *
 * The query is expected to be already normalized (trimmed); an empty query
 * matches everything.
 *
 * @param fields Candidate strings to test (e.g. a connection's name and host).
 * @param normalizedQuery The trimmed search query.
 */
export function textFieldsMatchQuery(fields: string[], normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return matchSorter(fields, normalizedQuery, { threshold: rankings.CONTAINS }).length > 0;
}
