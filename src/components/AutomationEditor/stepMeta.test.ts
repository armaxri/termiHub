import { describe, it, expect } from "vitest";
import { Clock, Cpu, FileCode, GitBranch, Keyboard, Play, Terminal } from "lucide-react";
import type { Automation } from "@/types/generated/Automation";
import {
  AUTOMATION_STEP_KINDS,
  EMPTY_STEP_SUMMARY,
  WORKFLOW_CONDITION_OPS,
  conditionOpLabel,
  newStep,
  newTrigger,
  offeredStepKinds,
  stepKindIcon,
  stepKindLabel,
  stepNotes,
  stepSummary,
  triggerKindIcon,
  triggerKindLabel,
  typingSpeedLabel,
} from "./stepMeta";

describe("offeredStepKinds", () => {
  it("offers the everyday kinds first and the rest under More", () => {
    expect(offeredStepKinds(true)).toEqual({
      basic: ["type-keys", "send-command", "wait", "wait-for-output"],
      more: ["conditional", "loop", "run-script", "run-automation", "run-local-process"],
    });
  });

  it("leaves out Run local process while the switch is off (#5818)", () => {
    expect(offeredStepKinds(false).more).toEqual([
      "conditional",
      "loop",
      "run-script",
      "run-automation",
    ]);
  });

  it("offers no further nesting inside a step", () => {
    expect(offeredStepKinds(true, true).more).toEqual([
      "run-script",
      "run-automation",
      "run-local-process",
    ]);
  });
});

describe("labels and icons", () => {
  it("lists every comparison operator in picker order, with a label", () => {
    expect([...WORKFLOW_CONDITION_OPS]).toEqual(["eq", "ne", "gt", "lt", "gte", "lte", "contains"]);
    expect(conditionOpLabel("eq")).toBe("equals");
    expect(conditionOpLabel("contains")).toBe("contains");
  });

  it("maps each kind to its icon", () => {
    expect(stepKindIcon("type-keys")).toBe(Keyboard);
    expect(stepKindIcon("send-command")).toBe(Terminal);
    expect(stepKindIcon("run-script")).toBe(FileCode);
    expect(stepKindIcon("run-automation")).toBe(Play);
    expect(stepKindIcon("wait")).toBe(Clock);
    expect(stepKindIcon("run-local-process")).toBe(Cpu);
    expect(stepKindIcon("conditional")).toBe(GitBranch);
  });

  it("maps step kinds to sentence-case labels, never a raw kind id (#5529)", () => {
    expect(stepKindLabel("type-keys")).toBe("Type keys");
    expect(stepKindLabel("send-command")).toBe("Run command");
    expect(stepKindLabel("run-automation")).toBe("Run automation");
    expect(stepKindLabel("wait-for-output")).toBe("Wait for output");
    for (const kind of AUTOMATION_STEP_KINDS) {
      const label = stepKindLabel(kind);
      expect(label).not.toContain("-");
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });

  it("falls back for a kind from a newer version", () => {
    expect(stepKindLabel("send-email" as never)).toBe("send-email");
    expect(stepKindIcon("send-email" as never)).toBeDefined();
    expect(triggerKindIcon("at-full-moon" as never)).toBeDefined();
  });

  it("maps trigger and run-trigger kinds to sentence-case labels", () => {
    expect(triggerKindLabel("manual")).toBe("Manual");
    expect(triggerKindLabel("on-connect")).toBe("On connect");
    expect(triggerKindLabel("hotkey")).toBe("Hotkey");
    expect(triggerKindLabel("scheduled")).toBe("Scheduled");
    expect(triggerKindLabel("on-disconnect")).toBe("On disconnect");
    expect(triggerKindLabel("on-output-match")).toBe("On output match");
  });

  it("names the recorded speed only for a recording", () => {
    expect(typingSpeedLabel("recorded", true)).toBe("As recorded");
    expect(typingSpeedLabel("recorded", false)).toBe("With the delays above");
  });
});

describe("newStep / newTrigger", () => {
  it("builds a default step for every kind", () => {
    for (const kind of AUTOMATION_STEP_KINDS) expect(newStep(kind).kind).toBe(kind);
    expect(newStep("type-keys")).toEqual({ kind: "type-keys", chunks: [], timing: "recorded" });
    expect(newStep("run-automation")).toEqual({ kind: "run-automation", automationId: "" });
    expect(newStep("wait")).toEqual({ kind: "wait", delayMs: 500 });
    expect(newStep("run-local-process")).toEqual({
      kind: "run-local-process",
      program: "",
      args: [],
    });
    expect(newStep("loop")).toEqual({ kind: "loop", loop: { kind: "count", count: 3 }, body: [] });
  });

  it("leaves optional fields absent", () => {
    expect(newStep("conditional")).not.toHaveProperty("else");
    expect(newStep("wait-for-output")).toEqual({ kind: "wait-for-output", pattern: "" });
  });

  it("builds a default trigger for every kind", () => {
    expect(newTrigger("hotkey")).toEqual({ kind: "hotkey", binding: "" });
    expect(newTrigger("on-connect")).toEqual({ kind: "on-connect", connectionIds: [] });
    expect(newTrigger("on-disconnect")).toEqual({ kind: "on-disconnect", connectionIds: [] });
    expect(newTrigger("on-output-match")).toEqual({
      kind: "on-output-match",
      connectionIds: [],
      pattern: "",
    });
  });
});

describe("stepSummary (#5637)", () => {
  const library: Pick<Automation, "id" | "name">[] = [{ id: "a1", name: "tail log" }];

  it("summarises each step kind on one line", () => {
    expect(
      stepSummary({
        kind: "type-keys",
        chunks: [
          { data: "git pull", delayMs: 0 },
          { data: "\r", delayMs: 10 },
        ],
      })
    ).toBe("git pull⏎");
    expect(stepSummary({ kind: "type-keys", chunks: [] })).toBe(EMPTY_STEP_SUMMARY);
    expect(stepSummary({ kind: "send-command", command: " make deploy " })).toBe("make deploy");
    expect(stepSummary({ kind: "send-command", command: "" })).toBe(EMPTY_STEP_SUMMARY);
    expect(stepSummary({ kind: "run-script", script: "a\n\nb\nc" })).toBe("a (+2 more)");
    expect(stepSummary({ kind: "run-script", script: "x", sourcePath: "/tmp/s/deploy.sh" })).toBe(
      "deploy.sh"
    );
    expect(stepSummary({ kind: "run-automation", automationId: "a1" }, library)).toBe("tail log");
    expect(stepSummary({ kind: "run-automation", automationId: "gone" }, library)).toBe(
      "Deleted automation"
    );
    expect(stepSummary({ kind: "run-automation", automationId: "" })).toBe(EMPTY_STEP_SUMMARY);
    expect(stepSummary({ kind: "run-local-process", program: "echo", args: ["a b"] })).toBe(
      "echo a b"
    );
    expect(
      stepSummary({
        kind: "conditional",
        condition: { left: "${x}", op: "eq", right: "1" },
        then: [{ kind: "wait", delayMs: 1 }],
      })
    ).toBe("If ${x} equals 1 · 1 step");
    expect(stepSummary({ kind: "loop", loop: { kind: "count", count: 3 }, body: [] })).toBe(
      "3× · 0 steps"
    );
    expect(stepSummary({ kind: "wait-for-output", pattern: "^ok$", isRegex: true })).toBe("/^ok$/");
  });

  it("shows durations in seconds (R-167)", () => {
    expect(stepSummary({ kind: "wait", delayMs: 1200 })).toBe("1.2 s");
    expect(stepSummary({ kind: "wait-for-output", pattern: "ok", timeoutMs: 30000 })).toBe(
      "ok · 30 s"
    );
  });
});

describe("stepNotes", () => {
  it("lists the failure policy", () => {
    expect(stepNotes({ kind: "wait", delayMs: 1 })).toEqual([]);
    expect(
      stepNotes({ kind: "wait", delayMs: 1, continueOnError: true, retry: { count: 2 } })
    ).toEqual(["Continues if it fails", "Retries 2×"]);
  });

  it("says what is recorded and how fast it types (#5820)", () => {
    const chunks = [
      { data: "l", delayMs: 0 },
      { data: "s", delayMs: 5 },
    ];
    expect(stepNotes({ kind: "type-keys", chunks, recorded: true, timing: "recorded" })).toEqual([
      "2 keys, recorded",
    ]);
    expect(stepNotes({ kind: "type-keys", chunks, timing: "fixed" })).toEqual(["40 ms per key"]);
    expect(stepNotes({ kind: "type-keys", chunks, timing: "instant" })).toEqual(["Instant"]);
  });
});
