/**
 * Tests for the machine-local run-script `sourcePath` trust helpers (#4310).
 */
import { describe, it, expect } from "vitest";
import { isScriptSourceConfirmed, withConfirmedScriptSource } from "./workflowScriptSources";

describe("isScriptSourceConfirmed", () => {
  it("trusts only an exact path on the allowlist", () => {
    expect(isScriptSourceConfirmed(["/home/u/deploy.sh"], "/home/u/deploy.sh")).toBe(true);
    expect(isScriptSourceConfirmed(["/home/u/deploy.sh"], "/home/u/./deploy.sh")).toBe(false);
    expect(isScriptSourceConfirmed(["/home/u/deploy.sh"], "/home/u/.ssh/id_ed25519")).toBe(false);
  });

  it("trusts nothing when the allowlist is absent or the path is empty", () => {
    expect(isScriptSourceConfirmed(undefined, "/x.sh")).toBe(false);
    expect(isScriptSourceConfirmed([""], "")).toBe(false);
  });
});

describe("withConfirmedScriptSource", () => {
  it("adds a new path once without mutating the input", () => {
    const input = ["/a.sh"];
    expect(withConfirmedScriptSource(input, "/b.sh")).toEqual(["/a.sh", "/b.sh"]);
    expect(input).toEqual(["/a.sh"]);
    expect(withConfirmedScriptSource(["/a.sh"], "/a.sh")).toEqual(["/a.sh"]);
  });

  it("starts from an empty list and ignores an empty path", () => {
    expect(withConfirmedScriptSource(undefined, "/a.sh")).toEqual(["/a.sh"]);
    expect(withConfirmedScriptSource(undefined, "")).toEqual([]);
  });
});
