import { describe, it, expect } from "vitest";
import { textFieldsMatchQuery } from "./searchMatching";

describe("textFieldsMatchQuery", () => {
  it("matches everything on an empty query", () => {
    expect(textFieldsMatchQuery(["anything"], "")).toBe(true);
    expect(textFieldsMatchQuery([], "")).toBe(true);
  });

  it("matches a case-insensitive substring in any field", () => {
    expect(textFieldsMatchQuery(["Production DB", "10.0.0.5"], "prod")).toBe(true);
    expect(textFieldsMatchQuery(["Production DB", "10.0.0.5"], "10.0.0")).toBe(true);
  });

  it("does not match when no field contains the query", () => {
    expect(textFieldsMatchQuery(["Production DB", "10.0.0.5"], "xyz")).toBe(false);
  });

  it("normalizes diacritics on both sides", () => {
    expect(textFieldsMatchQuery(["Café Server"], "cafe")).toBe(true);
    expect(textFieldsMatchQuery(["São Paulo"], "sao")).toBe(true);
    expect(textFieldsMatchQuery(["München"], "munchen")).toBe(true);
  });

  it("keeps substring semantics (no acronym/fuzzy matches below CONTAINS)", () => {
    // "ws" is an acronym of "Web Server" but not a substring — must not match,
    // matching the previous `.includes()` behavior.
    expect(textFieldsMatchQuery(["Web Server"], "ws")).toBe(false);
  });
});
