import { describe, it, expect } from "vitest";
import { shouldRegenerate, resolvePython, PYTHON_CANDIDATES } from "./regen-testid-catalog.mjs";

const WITH_ID = 'return <div data-testid="foo" />;';
const WITHOUT_ID = "return <div className='foo' />;";

describe("shouldRegenerate", () => {
  it("triggers for an app source .tsx under src/ containing a data-testid", () => {
    expect(shouldRegenerate("src/components/Settings/AboutSettings.tsx", WITH_ID)).toBe(true);
    expect(shouldRegenerate("src/hooks/useThing.ts", WITH_ID)).toBe(true);
  });

  it("triggers regardless of absolute vs relative path or backslashes", () => {
    expect(shouldRegenerate("/home/dev/repo/src/components/Foo.tsx", WITH_ID)).toBe(true);
    expect(shouldRegenerate("C:\\dev\\repo\\src\\components\\Foo.tsx", WITH_ID)).toBe(true);
  });

  it("does not trigger when the file has no data-testid", () => {
    expect(shouldRegenerate("src/components/Foo.tsx", WITHOUT_ID)).toBe(false);
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
