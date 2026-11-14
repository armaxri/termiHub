import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import path from "path";
import {
  ENDPOINTS,
  checkAboutLink,
  checkEndpoints,
  checkHttpClients,
  checkLinks,
  checkRepo,
  endpointText,
  headingAnchors,
  linkTargets,
  slugify,
} from "./check-privacy-notice.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let tmp = null;

/** A scratch repo holding `files` ({ "rel/path": "content" }). */
function repo(files) {
  tmp = mkdtempSync(path.join(tmpdir(), "privacy-check-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    writeFileSync(path.join(tmp, rel), content);
  }
  return tmp;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe("slugify / headingAnchors", () => {
  it("matches GitHub's heading anchors", () => {
    expect(slugify("Deleting it all")).toBe("deleting-it-all");
    expect(slugify("Plugin index and plugin updates")).toBe("plugin-index-and-plugin-updates");
    expect(slugify("Transfers outside the EU")).toBe("transfers-outside-the-eu");
  });
  it("ignores headings inside code fences", () => {
    expect(headingAnchors("# Real\n```\n# Fake\n```\n")).toEqual(new Set(["real"]));
  });
});

describe("linkTargets", () => {
  it("skips links inside code spans", () => {
    expect(linkTargets("[a](a.md) `[b](b.md)`")).toEqual(["a.md"]);
  });
});

describe("checkLinks", () => {
  it("accepts existing files and headings", () => {
    const root = repo({
      "PRIVACY.md": "[notice](docs/privacy.md#in-short) [web](https://example.com)",
      "docs/privacy.md": "# Privacy\n\n## In short\n",
    });
    expect(checkLinks(root, "PRIVACY.md")).toEqual([]);
  });
  it("reports a missing file and a missing heading", () => {
    const root = repo({
      "PRIVACY.md": "[gone](docs/gone.md) [bad](docs/privacy.md#nope) [self](#also-nope)",
      "docs/privacy.md": "# Privacy\n",
    });
    const problems = checkLinks(root, "PRIVACY.md");
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/docs\/gone\.md" points at a missing file/);
    expect(problems[1]).toMatch(/#nope" names a heading that does not exist/);
    expect(problems[2]).toMatch(/#also-nope" names a heading/);
  });
});

describe("checkAboutLink", () => {
  const about = (url) => ({
    "src/components/Settings/AboutSettings.tsx": `const PRIVACY_URL = "${url}";`,
  });
  it("accepts a URL naming an existing repo file", () => {
    const root = repo({
      ...about("https://github.com/armaxri/termiHub/blob/main/docs/privacy.md"),
      "docs/privacy.md": "# Privacy\n",
    });
    expect(checkAboutLink(root)).toEqual([]);
  });
  it("rejects a URL naming a missing file", () => {
    const root = repo(about("https://github.com/armaxri/termiHub/blob/main/docs/nope.md"));
    expect(checkAboutLink(root)[0]).toMatch(/docs\/nope\.md, which does not exist/);
  });
});

describe("endpoints", () => {
  it("fills the repository placeholder and cuts at the next one", () => {
    expect(endpointText("https://github.com/{GITHUB_REPO}/releases/download/{tag}/")).toBe(
      "github.com/armaxri/termiHub/releases/download/"
    );
  });
  it("reports an endpoint the notice does not name", () => {
    const endpoints = [{ what: "x", file: "x.rs", pattern: /URL: &str = "([^"]+)"/ }];
    const root = repo({ "x.rs": 'const URL: &str = "https://new.example/feed";' });
    expect(checkEndpoints(root, "nothing here", endpoints)[0]).toMatch(
      /does not name "new\.example\/feed"/
    );
    expect(checkEndpoints(root, "see new.example/feed", endpoints)).toEqual([]);
  });
  it("reports an endpoint whose source constant is gone", () => {
    const endpoints = [{ what: "x", file: "x.rs", pattern: /URL: &str = "([^"]+)"/ }];
    const root = repo({ "x.rs": "// moved" });
    expect(checkEndpoints(root, "", endpoints)[0]).toMatch(/endpoint not found in x\.rs/);
  });
  it("finds every real endpoint in the repository", () => {
    expect(checkEndpoints(ROOT, "", ENDPOINTS).filter((p) => /not found/.test(p))).toEqual([]);
  });
});

describe("checkHttpClients", () => {
  it("flags a new reqwest user and ignores test files", () => {
    const root = repo({
      "src-tauri/src/new_feed.rs": "use reqwest::Client;",
      "src-tauri/src/new_feed_tests.rs": "use reqwest::Client;",
      "src-tauri/src/commands/update.rs": "use reqwest::Client;",
    });
    const problems = checkHttpClients(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^src-tauri\/src\/new_feed\.rs uses reqwest/);
  });
});

describe("the repository", () => {
  it("passes every privacy notice check", () => {
    expect(checkRepo(ROOT)).toEqual([]);
  });
});
