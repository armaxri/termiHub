import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  shouldRegenerate,
  resolvePython,
  PYTHON_CANDIDATES,
  TESTID_ATTRS,
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

  it("triggers for each forwarding prop on its own", () => {
    for (const attr of TESTID_ATTRS) {
      expect(shouldRegenerate("src/components/Foo.tsx", `<X ${attr}="foo" />`)).toBe(true);
    }
  });

  it("does not trigger on a testid-like identifier that is not one of the props", () => {
    // `myTestId` / `testIdPrefix` merely embed a prop name; matching them would
    // regenerate the catalog on edits that cannot change it.
    expect(shouldRegenerate("src/components/Foo.tsx", "const myTestId = 1;")).toBe(false);
    expect(shouldRegenerate("src/components/Foo.tsx", "const testIdPrefix = 'x';")).toBe(false);
  });
});

describe("TESTID_ATTRS", () => {
  it("matches the Python generator's _TESTID_ATTRS exactly", () => {
    // The hook only decides *when* to run the Python generator — the catalog has
    // a single source of truth in build-testid-catalog.py. But this trigger list
    // duplicates the generator's attribute knowledge, and a prop added there
    // (as #1431's forwarded props were) would silently stop refreshing the
    // catalog after edits that only touch that prop. Pin the two together so the
    // gate cannot drift from the generator again (#1526).
    const script = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "build-testid-catalog.py"),
      "utf8"
    );
    const match = script.match(/^_TESTID_ATTRS\s*=\s*\(([^)]*)\)/m);
    expect(match, "could not find _TESTID_ATTRS in build-testid-catalog.py").not.toBeNull();
    const pythonAttrs = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(pythonAttrs.length).toBeGreaterThan(0);
    expect([...TESTID_ATTRS].sort()).toEqual(pythonAttrs.sort());
  });

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
