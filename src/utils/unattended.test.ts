import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import {
  unattendedBlockedReason,
  unattendedDefaults,
  unattendedParamValues,
  unattendedPasswordNote,
} from "./unattended";

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: "a",
  name: "A",
  tags: [],
  steps: [{ kind: "send-command", command: "uptime" }],
  triggers: [],
  createdAt: "",
  updatedAt: "",
  ...over,
});
const runs = (command: string) => automation({ steps: [{ kind: "send-command", command }] });
const nobody = () => undefined;

describe("values nobody is there to enter (A-047)", () => {
  it("a required value without a default keeps it from running", () => {
    const asks = automation({ parameters: [{ name: "env", type: "string", required: true }] });
    expect(unattendedParamValues(asks.parameters!)).toEqual({ missing: "env" });
    expect(unattendedBlockedReason(asks, nobody)).toContain("it asks for “env”");
    expect(unattendedDefaults(asks)).toBeNull();
  });

  it("values with a default are used and named", () => {
    const asks = automation({
      parameters: [
        { name: "env", label: "Environment", type: "enum", options: ["dev"], default: "dev" },
        { name: "note", type: "string" },
      ],
    });
    expect(unattendedBlockedReason(asks, nobody)).toBeNull();
    expect(unattendedDefaults(asks)).toBe(
      "Does not ask, it uses the default values: Environment = dev, note = (empty)."
    );
  });

  it("a step that waits for the user keeps it from running, also in one it runs (#6025)", () => {
    const waits = automation({
      id: "w",
      steps: [
        {
          kind: "loop",
          loop: { kind: "count", count: 1 },
          body: [{ kind: "wait-for-user" }],
        },
      ],
    });
    const calls = automation({ id: "c", steps: [{ kind: "run-automation", automationId: "w" }] });
    const find = (id: string) => (id === "w" ? waits : undefined);
    expect(unattendedBlockedReason(waits, nobody)).toContain("stops to let you type");
    expect(unattendedBlockedReason(calls, find)).toContain("stops to let you type");
    expect(unattendedBlockedReason(calls, nobody)).toBeNull();
  });

  it("says nothing when nothing is asked", () => {
    expect(unattendedBlockedReason(automation(), nobody)).toBeNull();
    expect(unattendedDefaults(automation())).toBeNull();
  });
});

describe("a password nobody is there to enter (A-047)", () => {
  const note = (a: Automation, resolve: (id: string) => Automation | undefined = nobody) =>
    unattendedPasswordNote(a, resolve);

  it("warns about commands that usually ask", () => {
    expect(note(runs("sudo reboot"))).toContain("“sudo”");
    expect(note(runs("cd /srv && sudo make"))).toContain("“sudo”");
    expect(note(runs("passwd"))).toContain("“passwd”");
    const keys: AutomationStep = {
      kind: "type-keys",
      chunks: [..."ls\rsudo -v\r"].map((data) => ({ data, delayMs: 0 })),
    };
    expect(note(automation({ steps: [keys] }))).toContain("“sudo”");
    expect(note(automation({ steps: [{ kind: "run-script", script: "ls\n  su -" }] }))).toContain(
      "“su”"
    );
  });

  it("not about words that only look like one", () => {
    for (const command of ["echo sudo", "cat sudoers", "./sudo-helper", "suspend", "uptime"]) {
      expect(note(runs(command))).toBeNull();
    }
  });

  it("warns when it waits for a password question", () => {
    const steps: AutomationStep[] = [
      { kind: "wait-for-output", pattern: "[Pp]assword:", timeoutMs: 1000 },
    ];
    expect(note(automation({ steps }))).toContain("waits for a password question");
  });

  it("looks into branches, loops and automations it runs, also in a cycle", () => {
    const sudo: AutomationStep = { kind: "send-command", command: "sudo id" };
    expect(
      note(
        automation({
          steps: [
            { kind: "conditional", condition: { left: "a", op: "eq", right: "a" }, then: [sudo] },
          ],
        })
      )
    ).toContain("“sudo”");
    const inner = automation({
      id: "b",
      steps: [{ kind: "run-automation", automationId: "a" }, sudo],
    });
    const outer = automation({ steps: [{ kind: "run-automation", automationId: "b" }] });
    expect(note(outer, (id) => (id === "b" ? inner : outer))).toContain("“sudo”");
    expect(note(outer)).toBeNull();
  });
});
