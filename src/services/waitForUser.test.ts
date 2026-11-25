/**
 * The "Wait for you" step in the runner (#6025): only Continue goes on. Whatever
 * the error handling of the step, or of anything around it, says, a wait nobody
 * answered ends the run with nothing more typed.
 */
import { describe, expect, it, vi } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { reachesWaitForUser, runAutomation } from "./automationRunner";
import {
  WAIT_FOR_USER_NOBODY,
  type WaitForUserResult,
  type WorkflowRunnerDeps,
} from "./workflowRunner";

const say = (command: string): AutomationStep => ({ kind: "send-command", command });
const wait = (over: Partial<AutomationStep> = {}): AutomationStep =>
  ({ kind: "wait-for-user", message: "Type your password", ...over }) as AutomationStep;
const automation = (id: string, steps: AutomationStep[]): Automation => ({
  id,
  name: id,
  tags: [],
  steps,
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

async function run(
  steps: AutomationStep[],
  answer: WaitForUserResult | null,
  others: Automation[] = []
) {
  const send = vi.fn((_data: string) => true);
  const waitForUser = vi.fn(async (_message: string | undefined) => answer ?? "continued");
  const deps: WorkflowRunnerDeps = {
    send,
    wait: async () => undefined,
    resolveAutomation: (id) => others.find((a) => a.id === id),
    ...(answer === null ? {} : { waitForUser }),
  };
  const result = await runAutomation(automation("root", steps), deps).done;
  return { result, sent: send.mock.calls.map(([data]) => data), waitForUser };
}

describe("a wait for the user", () => {
  it("goes on once the user continues", async () => {
    const { result, sent, waitForUser } = await run(
      [say("sudo -v"), wait(), say("ls")],
      "continued"
    );
    expect(result.status).toBe("completed");
    expect(sent).toEqual(["sudo -v\n", "ls\n"]);
    expect(waitForUser.mock.calls[0][0]).toBe("Type your password");
  });

  it("types nothing until then", async () => {
    let goOn: (result: WaitForUserResult) => void = () => {};
    const send = vi.fn(() => true);
    const handle = runAutomation(automation("root", [say("sudo -v"), wait(), say("ls")]), {
      send,
      waitForUser: () => new Promise((resolve) => (goOn = resolve)),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(send).toHaveBeenCalledTimes(1);
    goOn("continued");
    expect((await handle.done).status).toBe("completed");
    expect(send).toHaveBeenCalledTimes(2);
  });

  const inside: [string, (step: AutomationStep) => AutomationStep[], Automation[]][] = [
    ["as it is", (step) => [step], []],
    [
      "in a condition that tolerates failures",
      (step) => [
        {
          kind: "conditional",
          condition: { left: "a", op: "eq", right: "a" },
          then: [step],
          continueOnError: true,
          retry: { count: 3 },
        },
      ],
      [],
    ],
    [
      "in a loop that tolerates failures",
      (step) => [
        {
          kind: "loop",
          loop: { kind: "count", count: 3 },
          body: [step],
          continueOnError: true,
          retry: { count: 3 },
        },
      ],
      [],
    ],
    [
      "in an automation it runs and tolerates",
      () => [
        {
          kind: "run-automation",
          automationId: "inner",
          continueOnError: true,
          retry: { count: 3 },
        },
      ],
      [automation("inner", [wait({ continueOnError: true, retry: { count: 3 } })])],
    ],
  ];
  it.each(inside)("ends the run when nobody answers: %s", async (_where, around, others) => {
    const step = wait({ continueOnError: true, retry: { count: 3 } });
    for (const answer of ["timed-out", "gone"] as const) {
      const { result, sent, waitForUser } = await run(
        [say("sudo -v"), ...around(step), say("rm -rf x")],
        answer,
        others
      );
      expect(result.status).toBe("failed");
      expect(result.failedStepIndex).toBe(1);
      expect(result.error).toContain(
        answer === "gone" ? "closed or disconnected" : "nobody pressed Continue within 5 minutes"
      );
      expect(waitForUser).toHaveBeenCalledTimes(1);
      expect(sent).toEqual(["sudo -v\n"]);
    }
  });

  it("is canceled by Stop", async () => {
    const { result, sent } = await run([wait(), say("ls")], "cancelled");
    expect(result.status).toBe("cancelled");
    expect(sent).toEqual([]);
  });

  it("is canceled when Stop and Continue meet", async () => {
    const send = vi.fn(() => true);
    const handle = runAutomation(automation("root", [wait(), say("ls")]), {
      send,
      waitForUser: async () => {
        handle.cancel();
        return "continued";
      },
    });
    expect((await handle.done).status).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
  });

  it("ends a run nobody watches", async () => {
    const { result, sent } = await run([wait({ continueOnError: true }), say("ls")], null);
    expect(result).toMatchObject({ status: "failed", error: WAIT_FOR_USER_NOBODY });
    expect(sent).toEqual([]);
  });
});

it("is found wherever a run can reach it", () => {
  const inner = automation("inner", [
    {
      kind: "conditional",
      condition: { left: "", op: "eq", right: "x" },
      then: [],
      else: [wait()],
    },
  ]);
  const outer = automation("outer", [{ kind: "run-automation", automationId: "inner" }]);
  const find = (id: string) => (id === "inner" ? inner : undefined);
  expect(reachesWaitForUser(outer, find)).toBe(true);
  expect(reachesWaitForUser(outer, () => undefined)).toBe(false);
  expect(reachesWaitForUser(automation("x", [say("ls")]), find)).toBe(false);
});
