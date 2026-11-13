/**
 * `isSlotted` (#5620): the `measureTerminal` field that tells a grade whether
 * the terminal element is in its tab's panel slot or still parked off screen.
 */
import { afterEach, describe, expect, it } from "vitest";
import { isSlotted } from "./terminalRender";

afterEach(() => {
  document.body.replaceChildren();
});

describe("isSlotted", () => {
  it("is true for an element adopted into a terminal-container slot", () => {
    const slot = document.createElement("div");
    slot.className = "terminal-container ";
    const el = document.createElement("div");
    slot.appendChild(el);
    document.body.appendChild(slot);
    expect(isSlotted(el)).toBe(true);
  });

  it("is true for a hidden tab's slot too", () => {
    const slot = document.createElement("div");
    slot.className = "terminal-container terminal-container--hidden";
    const el = document.createElement("div");
    slot.appendChild(el);
    document.body.appendChild(slot);
    expect(isSlotted(el)).toBe(true);
  });

  it("is false for an element left in the parking node", () => {
    const parking = document.createElement("div");
    const el = document.createElement("div");
    parking.appendChild(el);
    document.body.appendChild(parking);
    expect(isSlotted(el)).toBe(false);
  });

  it("is false for a detached element", () => {
    const slot = document.createElement("div");
    slot.className = "terminal-container";
    const el = document.createElement("div");
    slot.appendChild(el);
    expect(isSlotted(el)).toBe(false);
  });
});
