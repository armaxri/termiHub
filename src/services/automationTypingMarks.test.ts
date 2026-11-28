import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  automationTypingLabel,
  markAutomationInput,
  resetAutomationTypingForTest,
  subscribeAutomationTyping,
  type AutomationTyping,
} from "./automationTypingMarks";

/**
 * #6021 (R-068): what an automation types into a terminal is marked there. The
 * marks go out once a run starts a line in a terminal, never for the user's own
 * typing, and say which automation typed it and what started it.
 */
const RUN = { automationId: "a1", name: "Deploy staging", origin: "scheduled" as const };

describe("markAutomationInput", () => {
  beforeEach(() => resetAutomationTypingForTest());

  it("marks where a run starts a line, not every key of it", async () => {
    const seen: AutomationTyping[] = [];
    subscribeAutomationTyping("tab-1", (typing) => seen.push(typing));
    const inject = vi.fn(() => true);
    const send = markAutomationInput(inject, RUN, () => 1000);
    for (const data of ["l", "s", " -la", "\r", "pwd\r", "e", "xit"]) await send("tab-1", data);
    expect(seen.map((s) => s.at)).toEqual([1000, 1000, 1000]);
    expect(seen[0]).toMatchObject(RUN);
    expect(inject).toHaveBeenCalledTimes(7);
    expect(inject).toHaveBeenNthCalledWith(1, "tab-1", "l");
  });

  it("takes a newline as the end of a line too, as a workflow's command ends", async () => {
    const seen = vi.fn();
    subscribeAutomationTyping("tab-1", seen);
    const send = markAutomationInput(() => true, RUN);
    await send("tab-1", "make\n");
    await send("tab-1", "make install\n");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("marks only the terminal it types into, each from its own first line", async () => {
    const one = vi.fn();
    const two = vi.fn();
    subscribeAutomationTyping("tab-1", one);
    subscribeAutomationTyping("tab-2", two);
    const send = markAutomationInput(() => true, RUN);
    await send("tab-2", "make\r");
    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
    await send("tab-1", "make");
    expect(one).toHaveBeenCalledTimes(1);
  });

  it("marks before the input goes out, so the mark is on the line it lands on", async () => {
    const order: string[] = [];
    subscribeAutomationTyping("tab-1", () => order.push("mark"));
    const send = markAutomationInput(() => {
      order.push("send");
      return true;
    }, RUN);
    await send("tab-1", "ls\r");
    expect(order).toEqual(["mark", "send"]);
  });

  it("carries the first line it types, to find where it echoes (#6183, automations-2)", async () => {
    const seen: AutomationTyping[] = [];
    subscribeAutomationTyping("tab-1", (typing) => seen.push(typing));
    const send = markAutomationInput(() => true, RUN);
    await send("tab-1", "sleep 1; echo READY\r");
    await send("tab-1", "printf 'a\\nb'\nnext\n");
    expect(seen.map((s) => s.text)).toEqual(["sleep 1; echo READY", "printf 'a\\nb'"]);
  });

  it("stops after an unsubscribe", async () => {
    const seen = vi.fn();
    const off = subscribeAutomationTyping("tab-1", seen);
    off();
    await markAutomationInput(() => true, RUN)("tab-1", "ls\r");
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("automationTypingLabel", () => {
  const at = new Date(2026, 10, 26, 14, 32, 8).getTime();
  it.each([
    ["scheduled", "on its schedule"],
    ["manual", "when you ran it"],
    ["hotkey", "by its hotkey"],
    ["on-connect", "when the connection opened"],
    ["on-output-match", "when the terminal output matched"],
    ["run-by-automation", "from another automation"],
  ] as const)("says what started a %s run", (origin, how) => {
    expect(automationTypingLabel({ ...RUN, origin, at })).toBe(
      `Typed by the automation “Deploy staging”, ${how}, at 14:32:08. Click to see its runs in History.`
    );
  });
});
