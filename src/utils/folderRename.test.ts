import { describe, it, expect } from "vitest";
import { folderRenameError } from "./folderRename";

describe("folderRenameError (#5233)", () => {
  it("accepts a name no sibling uses", () => {
    expect(folderRenameError("Jobs", ["Home", "laptop"])).toBeNull();
  });

  it("rejects an empty or blank name", () => {
    expect(folderRenameError("", [])).toBe("Enter a name.");
    expect(folderRenameError("   ", [])).toBe("Enter a name.");
  });

  it("rejects a sibling's exact name", () => {
    expect(folderRenameError("Home", ["Home"])).toBe(
      "“Home” already exists here. Choose another name."
    );
  });

  it("matches case-sensitively, like the store's de-duplication", () => {
    expect(folderRenameError("home", ["Home"])).toBeNull();
  });
});
