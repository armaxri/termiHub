import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
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
  CARGO_ABOUT_VERSION,
  EXTERNAL_TEXTS,
  cargoAboutPinProblems,
  configProblems,
  externalNoticeBody,
  flattenPnpmLicenses,
  fontNoticeProblems,
  listFontFiles,
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

describe("cargoAboutPinProblems", () => {
  it("accepts workflows pinning the generator's version", () => {
    expect(
      cargoAboutPinProblems({ "a.yml": `tool: cargo-about@${CARGO_ABOUT_VERSION}\n` })
    ).toEqual([]);
  });

  it("flags a drifted pin", () => {
    expect(cargoAboutPinProblems({ "a.yml": "tool: cargo-about@0.1.0" })).toEqual([
      `a.yml pins cargo-about@0.1.0, expected ${CARGO_ABOUT_VERSION}`,
    ]);
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

// #4357 (SUP2-003): bundled fonts come from no lockfile, so the notices only
// cover them through EXTERNAL_TEXTS. `notices:check` fails on an uncovered font.
describe("fontNoticeProblems", () => {
  const texts = [{ file: "licenses/a.txt", fonts: ["public/fonts/A.ttf"] }, { file: "x.txt" }];

  it("passes when every shipped font is covered", () => {
    expect(fontNoticeProblems(["public/fonts/A.ttf"], texts)).toEqual([]);
  });

  it("reports a shipped font with no license entry", () => {
    const problems = fontNoticeProblems(["public/fonts/A.ttf", "src/assets/B.woff2"], texts);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("bundled font src/assets/B.woff2 has no license entry");
  });

  it("reports a stale entry for a font that no longer exists", () => {
    expect(fontNoticeProblems([], texts)).toEqual([
      "EXTERNAL_TEXTS lists font public/fonts/A.ttf, which does not exist",
    ]);
  });
});

describe("bundled fonts in the real tree", () => {
  const fonts = listFontFiles(ROOT);

  it("finds the vendored Geist and MesloLGS Nerd Font files", () => {
    expect(fonts).toEqual(
      expect.arrayContaining([
        "public/fonts/MesloLGSNerdFontMono-Bold.ttf",
        "public/fonts/MesloLGSNerdFontMono-Regular.ttf",
        "src/assets/fonts/Geist-Variable.woff2",
      ])
    );
  });

  it("covers every shipped font file with an EXTERNAL_TEXTS entry", () => {
    expect(fontNoticeProblems(fonts, EXTERNAL_TEXTS)).toEqual([]);
  });

  it("ships the Geist OFL text and the Meslo / Nerd Fonts glyph-set texts", () => {
    for (const { file } of EXTERNAL_TEXTS)
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    const files = EXTERNAL_TEXTS.map((t) => t.file);
    expect(files).toContain("licenses/OFL-1.1-geist.txt");
    expect(files).toContain("licenses/Apache-2.0-meslo-lg.txt");
    expect(read("licenses/OFL-1.1-geist.txt")).toContain("SIL Open Font License, Version 1.1");
    // Every Nerd Fonts glyph source from upstream license-audit.md (v3.3.0).
    for (const glyphs of [
      "codicons",
      "devicons",
      "font-awesome",
      "font-awesome-extension",
      "font-logos",
      "iec-power-symbols",
      "material-design-icons",
      "octicons",
      "pomicons",
      "powerline-extra-symbols",
      "powerline-symbols",
      "seti-ui",
      "weather-icons",
    ]) {
      expect(
        files.some((f) => f.startsWith(`licenses/nerd-fonts-${glyphs}`)),
        glyphs
      ).toBe(true);
    }
  });

  it("documents both fonts in THIRD_PARTY_LICENSES.md", () => {
    const md = read("THIRD_PARTY_LICENSES.md");
    expect(md).toContain("## Bundled fonts");
    expect(md).toContain("Geist");
    expect(md).toContain("MesloLGS Nerd Font Mono");
    for (const { file } of EXTERNAL_TEXTS) expect(md, file).toContain(file);
  });
});
