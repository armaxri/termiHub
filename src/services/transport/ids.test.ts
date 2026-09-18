import { describe, it, expect } from "vitest";
import { newId, newIntentId, newClientId } from "./ids";

describe("newId", () => {
  it("prefixes the id with `<prefix>-` when a prefix is given", () => {
    const id = newId("macro");
    expect(id.startsWith("macro-")).toBe(true);
    // A ULID is 26 chars; `macro-` is 6.
    expect(id.length).toBe("macro-".length + 26);
  });

  it("uses different prefixes for different domains", () => {
    expect(newId("workflow").startsWith("workflow-")).toBe(true);
    expect(newId("conn").startsWith("conn-")).toBe(true);
  });

  it("returns a bare ULID when no prefix is given", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("mints distinct ids on rapid successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId("macro")));
    expect(ids.size).toBe(100);
  });
});

describe("newIntentId", () => {
  it("returns a bare ULID", () => {
    expect(newIntentId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("newClientId", () => {
  it("prefixes with `client-`", () => {
    expect(newClientId().startsWith("client-")).toBe(true);
  });
});
