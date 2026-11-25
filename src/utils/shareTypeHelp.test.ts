import { describe, expect, it } from "vitest";
import { SHARE_TYPE_KINDS, shareTypeHelp } from "./shareTypeHelp";
import { UNREADABLE_HOST } from "./hostChoice";

describe("shareTypeHelp (#6036)", () => {
  it.each(SHARE_TYPE_KINDS)("%s says what it is for without its protocol", (kind) => {
    const help = shareTypeHelp(kind);
    expect(help.protocol).toBe(kind.toUpperCase());
    // The phrase for a row: plain words, short, no full stop.
    expect(help.summary.toLowerCase()).not.toContain(kind);
    expect(help.summary.length).toBeLessThanOrEqual(40);
    expect(help.summary.endsWith(".")).toBe(false);
    for (const line of help.lines) expect(line.endsWith(".")).toBe(true);
    expect(help.lines[1]).toContain("this computer");
    expect(help.lines[2]).toMatch(/^Example: /);
  });

  it("tells the three apart", () => {
    const summaries = SHARE_TYPE_KINDS.map((kind) => shareTypeHelp(kind).summary);
    expect(new Set(summaries).size).toBe(3);
  });

  it("says who can upload and who signs in, as the servers do", () => {
    expect(shareTypeHelp("http").lines[1]).toContain("not upload");
    expect(shareTypeHelp("ftp").lines[1]).toContain("sign in");
    expect(shareTypeHelp("tftp").lines[1]).toContain("no sign-in");
  });

  it("names the machine that serves", () => {
    const edge = { kind: "agent", agentId: "a1" } as const;
    expect(shareTypeHelp("http", edge, "Edge box").lines[1]).toContain("on agent Edge box");
    expect(shareTypeHelp("http", edge).lines[1]).toContain("on agent a1");
    expect(shareTypeHelp("http", UNREADABLE_HOST).lines[1]).toContain("an unknown machine");
  });
});
