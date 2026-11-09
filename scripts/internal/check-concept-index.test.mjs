import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { checkIndex, checkRepo, extractLinks, listConcepts } from "./check-concept-index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const README = [
  "# Concept Documents",
  "See [`_assets/`](_assets/) and [mockups](mockups-index.html#top), or [GitHub](https://github.com).",
  "",
  "## implemented/",
  "",
  "| [a.html](implemented/a.html) | A |",
  "",
  "## backlog/",
  "",
  "| [b.html](backlog/b.html) | B |",
  "",
  "```",
  "[ignored](implemented/fenced.html)",
  "```",
].join("\n");

const EXISTING = new Set(["_assets", "mockups-index.html", "implemented/a.html", "backlog/b.html"]);
const exists = (rel) => EXISTING.has(rel.replace(/\/$/, ""));

describe("extractLinks", () => {
  it("returns relative links with their status section, skipping URLs and fences", () => {
    expect(extractLinks(README)).toEqual([
      { target: "_assets/", section: null, line: 2 },
      { target: "mockups-index.html#top", section: null, line: 2 },
      { target: "implemented/a.html", section: "implemented", line: 6 },
      { target: "backlog/b.html", section: "backlog", line: 10 },
    ]);
  });
});

describe("checkIndex", () => {
  it("passes a consistent index", () => {
    expect(checkIndex(README, ["backlog/b.html", "implemented/a.html"], exists)).toEqual([]);
  });

  it("flags a concept with no row", () => {
    const problems = checkIndex(
      README,
      ["implemented/a.html", "backlog/b.html", "future/c.html"],
      exists
    );
    expect(problems).toEqual([
      "docs/concepts/README.md: concept `future/c.html` is not linked — add a row to its `## future/` table",
    ]);
  });

  it("flags a dead link", () => {
    const readme = README.replace("implemented/a.html)", "implemented/gone.html)");
    const problems = checkIndex(readme, ["backlog/b.html"], exists);
    expect(problems).toEqual([
      "docs/concepts/README.md:6: links `implemented/gone.html`, which does not exist",
    ]);
  });

  it("flags a concept listed under the wrong section", () => {
    const readme = README.replace("## backlog/", "## future/");
    const problems = checkIndex(readme, ["implemented/a.html", "backlog/b.html"], exists);
    expect(problems).toEqual([
      "docs/concepts/README.md:10: `backlog/b.html` is listed under `## future/` but lives in `backlog/`",
    ]);
  });
});

describe("real repository", () => {
  it("finds the concept files", () => {
    expect(listConcepts(ROOT).length).toBeGreaterThan(10);
  });

  it("docs/concepts/README.md links every concept and no dead path", () => {
    const { problems } = checkRepo(ROOT);
    expect(problems).toEqual([]);
  });
});
