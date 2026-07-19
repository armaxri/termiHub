import { describe, expect, it } from "vitest";
import { VNC_BASE_PORT, vncPortForDisplay } from "./vncDisplayPort";

describe("vncPortForDisplay", () => {
  it("maps display 0 to the base port 5900", () => {
    expect(vncPortForDisplay(0)).toBe(5900);
    expect(VNC_BASE_PORT).toBe(5900);
  });

  it("adds the display number to the base port", () => {
    expect(vncPortForDisplay(1)).toBe(5901);
    expect(vncPortForDisplay(5)).toBe(5905);
    expect(vncPortForDisplay(99)).toBe(5999);
  });

  it("accepts the top of the schema's display range (255)", () => {
    expect(vncPortForDisplay(255)).toBe(6155);
  });

  it("returns null for a cleared / empty display so the port is left untouched", () => {
    expect(vncPortForDisplay(undefined)).toBeNull();
    expect(vncPortForDisplay(null)).toBeNull();
    expect(vncPortForDisplay("")).toBeNull();
  });

  it("returns null for non-numeric or invalid input rather than fighting the user", () => {
    expect(vncPortForDisplay("abc")).toBeNull();
    expect(vncPortForDisplay(NaN)).toBeNull();
    expect(vncPortForDisplay(Infinity)).toBeNull();
  });

  it("returns null for negative or non-integer displays", () => {
    expect(vncPortForDisplay(-1)).toBeNull();
    expect(vncPortForDisplay(1.5)).toBeNull();
  });

  it("coerces a numeric string display (as widgets may emit) to its port", () => {
    expect(vncPortForDisplay("3")).toBe(5903);
  });

  it("returns null when the derived port would exceed the valid TCP range", () => {
    expect(vncPortForDisplay(60000)).toBeNull();
  });
});
