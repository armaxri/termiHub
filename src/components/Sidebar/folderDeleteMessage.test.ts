import { describe, it, expect } from "vitest";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";
import { folderDeleteMessage } from "./folderDeleteMessage";

const folder = (id: string, parentId: string | null): ConnectionFolder => ({
  id,
  name: id.split("/").pop()!,
  parentId,
  isExpanded: true,
});
const conn = (id: string, folderId: string): SavedConnection => ({
  id,
  name: id,
  folderId,
  config: { type: "local", config: {} },
});

describe("folderDeleteMessage (#5158)", () => {
  it("names an empty folder only", () => {
    expect(folderDeleteMessage([folder("A", null)], [], "A")).toBe("Delete folder “A”?");
  });

  it("says a top-level folder's contents move to the top level", () => {
    const folders = [folder("A", null), folder("A/B", "A")];
    const message = folderDeleteMessage(folders, [conn("x", "A"), conn("y", "A")], "A");
    expect(message).toBe(
      "Delete folder “A”? Its 2 connections and 1 subfolder will move to the top level."
    );
  });

  it("names the parent a nested folder's contents move to", () => {
    const folders = [folder("A", null), folder("A/B", "A")];
    expect(folderDeleteMessage(folders, [conn("x", "A/B")], "A/B")).toBe(
      "Delete folder “B”? Its 1 connection will move to “A”."
    );
  });
});
