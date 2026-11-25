import { describe, expect, it } from "vitest";
import { deletedConnectionLabel } from "./deletedConnection";

describe("deletedConnectionLabel (#6024)", () => {
  it("keeps the name a connection had: the last part of its path", () => {
    expect(deletedConnectionLabel("Work/Old Box")).toBe("Deleted connection “Old Box”");
    expect(deletedConnectionLabel("Scratch")).toBe("Deleted connection “Scratch”");
  });

  it("shows no generated id", () => {
    for (const id of ["", "conn-1", "conn-1700000000", "3f1c9a2e-0b1d-4c55-9b1e-aaaaaaaaaaaa"]) {
      expect(deletedConnectionLabel(id)).toBe("Deleted connection");
    }
  });
});
