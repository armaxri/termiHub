import { describe, it, expect } from "vitest";
import { renderOutdated } from "./pnpm-outdated-summary.mjs";

describe("renderOutdated (#5011)", () => {
  it("says everything is up to date for an empty payload", () => {
    expect(renderOutdated("")).toContain("All direct npm dependencies are up to date.");
    expect(renderOutdated("{}")).toContain("All direct npm dependencies are up to date.");
  });

  it("renders one sorted table row per outdated package", () => {
    const md = renderOutdated(
      JSON.stringify({
        zustand: {
          current: "5.0.13",
          wanted: "5.0.13",
          latest: "5.0.16",
          dependencyType: "dependencies",
        },
        "@types/ws": {
          current: "8.18.1",
          wanted: "8.18.1",
          latest: "8.18.2",
          isDeprecated: true,
          dependencyType: "devDependencies",
        },
      })
    );
    expect(md).toContain("2 direct package(s) have a newer version:");
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Package"));
    expect(rows.slice(1)).toEqual([
      "| @types/ws (deprecated) | 8.18.1 | 8.18.1 | 8.18.2 | devDependencies |",
      "| zustand | 5.0.13 | 5.0.13 | 5.0.16 | dependencies |",
    ]);
  });

  it("warns instead of throwing on an unparseable payload", () => {
    expect(renderOutdated("ERR_PNPM_FETCH")).toContain("Could not parse");
    expect(renderOutdated("[]")).toContain("Could not parse");
  });
});
