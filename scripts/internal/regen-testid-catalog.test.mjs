import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  shouldRegenerate,
  resolvePython,
  PYTHON_CANDIDATES,
  TESTID_TRIGGER,
} from "./regen-testid-catalog.mjs";

const WITH_ID = 'return <div data-testid="foo" />;';
const WITHOUT_ID = "return <div className='foo' />;";

// A consumer that forwards its ids through the shared sidebar shell's props and
// never writes a raw `data-testid` (#1431). The Python scanner catalogs these,
// so the hook's trigger predicate must fire for them too.
const FORWARDED_ONLY = `
  <SidebarListItem
    testId="server-item-one"
    nameTestId={\`server-name-\${id}\`}
    badgeTestId="server-type-one"
  />`;

describe("shouldRegenerate", () => {
  it("triggers for an app source .tsx under src/ containing a data-testid", () => {
    expect(shouldRegenerate("src/components/Settings/AboutSettings.tsx", WITH_ID)).toBe(true);
    expect(shouldRegenerate("src/hooks/useThing.ts", WITH_ID)).toBe(true);
  });

  it("triggers regardless of absolute vs relative path or backslashes", () => {
    expect(shouldRegenerate("/home/dev/repo/src/components/Foo.tsx", WITH_ID)).toBe(true);
    expect(shouldRegenerate("C:\\dev\\repo\\src\\components\\Foo.tsx", WITH_ID)).toBe(true);
  });

  it("does not trigger when the file has no testid at all", () => {
    expect(shouldRegenerate("src/components/Foo.tsx", WITHOUT_ID)).toBe(false);
  });

  it("triggers for ids forwarded through the sidebar shell's props (#1431)", () => {
    // These render as real testids and the Python scanner catalogs them, so an
    // edit here must refresh the catalog even with no raw `data-testid` present.
    expect(shouldRegenerate("src/components/Foo/FooItem.tsx", FORWARDED_ONLY)).toBe(true);
  });

  it("triggers for every sink form the generator scans (#3044)", () => {
    const forms = [
      '<X testId="foo" />',
      "<X toggleTestId={`row-${i}`} />",
      '<X footerTestId="foo-footer" />',
      '<X rowTestIdPrefix="dns-result" />',
      'const cfg = { "data-testid": "foo-bar" };',
      'const cfg = { modalTestId: "foo-modal" };',
      'el.setAttribute("data-testid", "terminal-root");',
      "const myTestId = `foo-${id}`;",
    ];
    for (const form of forms) {
      expect(shouldRegenerate("src/components/Foo.tsx", form), form).toBe(true);
    }
  });
});

describe("TESTID_TRIGGER", () => {
  it("is the Python generator's _TRIGGER pattern exactly", () => {
    // The hook only decides *when* to run the Python generator — the catalog has
    // a single source of truth in build-testid-catalog.py. This trigger mirrors
    // the generator's own gate (scan_testids skips text that does not match it),
    // so pinning the two keeps the hook from missing any sink the generator
    // catalogs. A hand-kept attribute list drifted twice (#1431, #3044); #1526.
    const script = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "build-testid-catalog.py"),
      "utf8"
    );
    const match = script.match(/^_TRIGGER\s*=\s*re\.compile\(\s*r"([^"]+)"\s*\)/m);
    expect(match, "could not find _TRIGGER in build-testid-catalog.py").not.toBeNull();
    expect(TESTID_TRIGGER.source).toBe(match[1]);
    expect(TESTID_TRIGGER.flags).toBe("");
  });
});

describe("shouldRegenerate path filtering", () => {
  it("does not trigger for files outside src/", () => {
    expect(shouldRegenerate("scripts/internal/foo.ts", WITH_ID)).toBe(false);
    expect(shouldRegenerate("tests/system/thing.tsx", WITH_ID)).toBe(false);
  });

  it("does not trigger for non ts/tsx files", () => {
    expect(shouldRegenerate("src/components/Foo.css", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/components/Foo.js", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/data/thing.json", WITH_ID)).toBe(false);
  });

  it("skips test / spec / declaration files (mirrors the Python scanner)", () => {
    expect(shouldRegenerate("src/components/Foo.test.tsx", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/components/Foo.test.ts", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/components/Foo.spec.tsx", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/types/foo.d.ts", WITH_ID)).toBe(false);
  });

  it("skips test/mock/testbridge directories", () => {
    expect(shouldRegenerate("src/components/__tests__/Foo.tsx", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/test/helpers.tsx", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/__mocks__/Foo.tsx", WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/testbridge/selectors.tsx", WITH_ID)).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    expect(shouldRegenerate(null, WITH_ID)).toBe(false);
    expect(shouldRegenerate("src/components/Foo.tsx", null)).toBe(false);
    expect(shouldRegenerate(undefined, undefined)).toBe(false);
  });
});

describe("resolvePython", () => {
  it("returns the first candidate whose probe succeeds", () => {
    const tried = [];
    const probe = (argv) => {
      tried.push(argv.join(" "));
      return argv[0] === "python"; // first real interpreter
    };
    expect(resolvePython(PYTHON_CANDIDATES, probe)).toEqual(["python"]);
    // python3 was tried first and rejected, then python matched — no further tries.
    expect(tried).toEqual(["python3", "python"]);
  });

  it("skips a Windows-stub-like candidate (probe false) and falls through", () => {
    // Simulate python3/python being the App-Execution-Alias stub (probe false),
    // so resolution falls through to a working `py -3`.
    const probe = (argv) => argv.join(" ") === "py -3";
    expect(resolvePython(PYTHON_CANDIDATES, probe)).toEqual(["py", "-3"]);
  });

  it("returns null when no candidate is a usable interpreter", () => {
    expect(resolvePython(PYTHON_CANDIDATES, () => false)).toBeNull();
  });

  it("preserves candidate order and stops at the first match", () => {
    const order = [["a"], ["b"], ["c"]];
    const seen = [];
    resolvePython(order, (argv) => {
      seen.push(argv[0]);
      return argv[0] === "b";
    });
    expect(seen).toEqual(["a", "b"]);
  });
});
