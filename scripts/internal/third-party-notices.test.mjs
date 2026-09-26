import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  NoticesBuilder,
  displayExpression,
  normalizeText,
  spdxAllowed,
  wrapList,
} from "./third-party-notices-model.mjs";
import {
  configProblems,
  externalNoticeBody,
  flattenPnpmLicenses,
  tomlStringArray,
} from "./third-party-notices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const ALLOWED = new Set(["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "ISC"]);

describe("spdxAllowed", () => {
  it("accepts a single allowed id", () => {
    expect(spdxAllowed("MIT", ALLOWED)).toBe(true);
  });

  it("rejects an id outside the allowlist", () => {
    expect(spdxAllowed("GPL-3.0-only", ALLOWED)).toBe(false);
  });

  it("needs only one arm of an OR", () => {
    expect(spdxAllowed("(GPL-2.0-only OR MIT)", ALLOWED)).toBe(true);
    expect(spdxAllowed("GPL-2.0-only OR LGPL-2.1-only", ALLOWED)).toBe(false);
  });

  it("needs every arm of an AND", () => {
    expect(spdxAllowed("MIT AND ISC", ALLOWED)).toBe(true);
    expect(spdxAllowed("MIT AND GPL-3.0-only", ALLOWED)).toBe(false);
  });

  it("honours nesting and WITH exceptions", () => {
    expect(spdxAllowed("ISC AND (GPL-3.0-only OR Apache-2.0)", ALLOWED)).toBe(true);
    expect(spdxAllowed("Apache-2.0 WITH LLVM-exception", ALLOWED)).toBe(true);
    expect(spdxAllowed("GPL-2.0-only WITH Classpath-exception-2.0", ALLOWED)).toBe(false);
  });

  it("rejects empty, malformed and non-SPDX values", () => {
    expect(spdxAllowed("", ALLOWED)).toBe(false);
    expect(spdxAllowed(undefined, ALLOWED)).toBe(false);
    expect(spdxAllowed("(MIT OR", ALLOWED)).toBe(false);
    expect(spdxAllowed("SEE LICENSE IN LICENSE.txt", ALLOWED)).toBe(false);
  });
});

describe("tomlStringArray", () => {
  const toml = [
    "[advisories]",
    'allow = ["not-this"]',
    "",
    "[licenses]",
    "# comment",
    "allow = [",
    '    "MIT", # trailing comment',
    '    # "Commented-Out",',
    '    "Apache-2.0",',
    "]",
  ].join("\n");

  it("reads a multi-line array inside the requested table", () => {
    expect(tomlStringArray(toml, "allow", "licenses")).toEqual(["MIT", "Apache-2.0"]);
  });

  it("returns null when the key is absent", () => {
    expect(tomlStringArray(toml, "accepted")).toBeNull();
  });
});

describe("configProblems", () => {
  const deny = '[licenses]\nallow = ["MIT", "ISC"]\n';

  it("is clean when about.toml mirrors deny.toml", () => {
    expect(configProblems({ about: 'accepted = ["ISC", "MIT"]', deny, sidecarDeny: null })).toEqual(
      []
    );
  });

  it("reports drift in both directions and against the sidecar allowlist", () => {
    const problems = configProblems({
      about: 'accepted = ["MIT", "Zlib"]',
      deny,
      sidecarDeny: '[licenses]\nallow = ["MIT", "BSL-1.0"]\n',
    });
    expect(problems).toEqual([
      'about.toml accepted is missing "ISC" (in deny.toml)',
      'about.toml accepts "Zlib", which deny.toml does not allow',
      'about.toml accepted is missing "BSL-1.0" (in rdp-sidecar/deny.toml)',
    ]);
  });

  it("holds for the repository's real config files", () => {
    expect(
      configProblems({
        about: read("about.toml"),
        deny: read("deny.toml"),
        sidecarDeny: read("rdp-sidecar/deny.toml"),
      })
    ).toEqual([]);
  });
});

describe("text helpers", () => {
  it("normalizes line endings, trailing whitespace and edge blank lines", () => {
    expect(normalizeText("﻿\r\n\r\nMIT License  \r\n\r\nCopyright\t\r\n\n")).toBe(
      "MIT License\n\nCopyright"
    );
  });

  it("wraps a list under a hanging indent", () => {
    expect(wrapList("Used by: ", ["alpha", "beta", "gamma"], 20)).toEqual([
      "Used by: alpha,",
      "         beta, gamma",
    ]);
  });

  it("drops redundant outer parentheses only", () => {
    expect(displayExpression("(MPL-2.0 OR Apache-2.0)")).toBe("MPL-2.0 OR Apache-2.0");
    expect(displayExpression("(A OR B) AND (C OR D)")).toBe("(A OR B) AND (C OR D)");
  });

  it("strips the title and maintainer section from THIRD_PARTY_LICENSES.md", () => {
    const body = externalNoticeBody("# Title\n\nIntro\n\n---\n\n## Maintenance\n\nSteps\n");
    expect(body).toBe("\nIntro\n");
  });

  it("flattens pnpm's report into sorted per-version records", () => {
    const rows = flattenPnpmLicenses({
      MIT: [{ name: "b", versions: ["1.0.0", "2.0.0"], paths: ["/p/b1", "/p/b2"], license: "MIT" }],
      ISC: [{ name: "a", versions: ["3.0.0"], paths: ["/p/a"], license: "ISC" }],
    });
    expect(rows.map((r) => `${r.name}@${r.version}:${r.path}`)).toEqual([
      "a@3.0.0:/p/a",
      "b@1.0.0:/p/b1",
      "b@2.0.0:/p/b2",
    ]);
  });
});

describe("NoticesBuilder", () => {
  const mitText = "MIT License\n\nCopyright (c) Foo";
  const standardMit = "MIT License\n\nCopyright (c) <year> <copyright holders>";

  function build() {
    const builder = new NoticesBuilder();
    builder.addCargoAbout("desktop", {
      crates: [
        { package: { name: "foo", version: "1.0.0" }, license: "MIT" },
        { package: { name: "bar", version: "0.1.0" }, license: "MIT" },
      ],
      licenses: [
        {
          id: "MIT",
          text: mitText,
          source_path: "/x/LICENSE",
          used_by: [{ crate: { name: "foo", version: "1.0.0" } }],
        },
        {
          id: "MIT",
          text: standardMit,
          source_path: null,
          used_by: [{ crate: { name: "bar", version: "0.1.0" } }],
        },
      ],
    });
    builder.addCargoAbout("agent", {
      crates: [{ package: { name: "foo", version: "1.0.0" }, license: "MIT" }],
      licenses: [
        {
          id: "MIT",
          text: `${mitText}\r\n`,
          source_path: "/y/LICENSE",
          used_by: [{ crate: { name: "foo", version: "1.0.0" } }],
        },
      ],
    });
    builder.addNpm({
      name: "pkg",
      version: "2.0.0",
      license: "MIT",
      files: [{ name: "LICENSE", text: mitText }],
    });
    builder.addNpm({ name: "bare", version: "1.0.0", license: "(MIT)", files: [] });
    builder.addNpm({ name: "odd", version: "1.0.0", license: "WTFPL", files: [] });
    builder.resolveMissingNpmTexts();
    return builder;
  }

  it("merges components per crate and dedupes identical texts", () => {
    const builder = build();
    expect([...builder.crates.get("foo 1.0.0").components].sort()).toEqual(["agent", "desktop"]);
    expect(builder.texts.size).toBe(2);
  });

  it("attaches the standard text to npm packages without a license file", () => {
    const builder = build();
    const bare = builder.npm.get("bare 1.0.0");
    expect(bare.texts.size).toBe(1);
    expect(bare.note).toContain("standard license text");
    expect(builder.missing).toEqual(["npm odd 1.0.0 (WTFPL)"]);
  });

  it("renders every section with cross-referenced texts, deterministically", () => {
    const text = build().render({ version: "9.9.9", externalNotice: "X servers here" });
    expect(text).toContain("termiHub 9.9.9 is licensed under the MIT License");
    expect(text).toContain("foo 1.0.0 - MIT - agent, desktop - [L2]");
    expect(text).toContain("bar 0.1.0 - MIT - desktop - [L1]");
    expect(text).toContain("pkg 2.0.0 - MIT - [L2]");
    expect(text).toContain("odd 1.0.0 - WTFPL - (none) (no license file in package)");
    expect(text).toContain("X servers here");
    expect(text).toContain("(standard license text - the package ships no license file)");
    expect(text).toContain("Used by: foo 1.0.0, pkg 2.0.0");
    expect(build().render({ version: "9.9.9", externalNotice: "X servers here" })).toBe(text);
  });
});
