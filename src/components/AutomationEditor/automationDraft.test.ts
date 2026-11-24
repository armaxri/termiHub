/**
 * The round-trip guarantee of the automation editor (#5818, slice 7), graded on
 * the Rust model's golden files: every step and trigger kind, nested lists,
 * several triggers of one kind, recorded control bytes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import {
  draftContentKey,
  duplicateStepDraft,
  fromDraft,
  fromStepDraft,
  onlyTypesKeys,
  remapDraftTriggers,
  toDraft,
  toStepDraft,
} from "./automationDraft";

const TESTDATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src-tauri/src/automations/testdata"
);
const golden = ["legacy.expected.json", "collision.expected.json"].flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(TESTDATA, file), "utf8")) as { automations: Automation[] })
      .automations
);
const bytes = (value: unknown) => JSON.stringify(value);

/** A copy of `value` with a field this build does not know in every object. */
function withFutureFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withFutureFields) as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = withFutureFields(v);
  return { ...out, futureField: { nested: [1, "x"] } } as T;
}

describe("the draft of a stored automation", () => {
  it("covers every step and trigger kind", () => {
    const kinds = new Set<string>();
    const visit = (steps: AutomationStep[]) => {
      for (const step of steps) {
        kinds.add(step.kind);
        if (step.kind === "conditional") visit([...step.then, ...(step.else ?? [])]);
        if (step.kind === "loop") visit(step.body);
      }
    };
    for (const a of golden) {
      visit(a.steps);
      for (const trigger of a.triggers) kinds.add(trigger.kind);
    }
    expect([...kinds].sort()).toEqual(
      [
        "conditional",
        "hotkey",
        "loop",
        "on-connect",
        "on-disconnect",
        "on-output-match",
        "run-automation",
        "run-local-process",
        "run-script",
        "send-command",
        "type-keys",
        "wait",
        "wait-for-output",
      ].sort()
    );
  });

  it.each(golden.map((a) => [a.name, a] as const))("saves %s back byte for byte", (_name, a) => {
    expect(bytes(fromDraft(toDraft(a), a))).toBe(bytes(a));
  });

  it.each(golden.map((a) => [a.name, a] as const))(
    "keeps the fields of %s it does not know",
    (_name, a) => {
      const future = withFutureFields(a);
      expect(bytes(fromDraft(toDraft(future), future))).toBe(bytes(future));
    }
  );

  it("keeps a step and a trigger of a kind it does not know", () => {
    const a = {
      ...golden[0],
      steps: [{ kind: "send-email", to: ["x"] } as unknown as AutomationStep],
      triggers: [{ kind: "at-full-moon" } as never],
    };
    expect(bytes(fromDraft(toDraft(a), a))).toBe(bytes(a));
  });

  it("changes nothing but the edited field", () => {
    for (const a of golden.map(withFutureFields)) {
      const saved = fromDraft({ ...toDraft(a), name: "  Renamed  " }, a);
      expect(bytes(saved)).toBe(bytes({ ...a, name: "Renamed" }));
    }
  });

  it("keeps what editing would normalize, until it is edited", () => {
    const a: Automation = {
      ...golden[0],
      name: " spaced ",
      description: "line one\nline two ".padEnd(120, "x"),
      tags: ["a, b", " c "],
      parameters: [],
      triggersEnabled: true,
    };
    const draft = toDraft(a);
    expect(bytes(fromDraft(draft, a))).toBe(bytes(a));
    expect(fromDraft({ ...draft, tags: "a, b" }, a).tags).toEqual(["a", "b"]);
    expect(fromDraft({ ...draft, description: "  " }, a)).not.toHaveProperty("description");
  });

  it("writes the Armed switch only when it changes", () => {
    const armed = golden.find((a) => a.triggers.length > 0 && a.triggersEnabled === undefined)!;
    const off = golden.find((a) => a.triggersEnabled === false)!;
    expect(fromDraft({ ...toDraft(armed), triggersEnabled: false }, armed).triggersEnabled).toBe(
      false
    );
    expect(fromDraft({ ...toDraft(off), triggersEnabled: true }, off)).not.toHaveProperty(
      "triggersEnabled"
    );
  });

  it("drops the parameters key once the last one is removed", () => {
    const a = golden.find((x) => x.parameters?.length)!;
    expect(fromDraft({ ...toDraft(a), parameters: [] }, a)).not.toHaveProperty("parameters");
  });
});

describe("type-keys drafts", () => {
  const recorded = golden.find((a) => a.name === "Quit vim")!.steps[0];

  it("keeps every other chunk when one is edited", () => {
    if (recorded.kind !== "type-keys") throw new Error("fixture");
    const draft = toStepDraft(recorded);
    const keys = draft.keys!.map((k, i) => (i === 1 ? { ...k, text: ":q!\\r" } : k));
    const saved = fromStepDraft({ ...draft, keys });
    expect(saved).toEqual({
      ...recorded,
      chunks: recorded.chunks.map((c, i) => (i === 1 ? { ...c, data: ":q!\r" } : c)),
    });
  });

  it("saves whole, non-negative delays", () => {
    const draft = toStepDraft({ kind: "type-keys", chunks: [{ data: "a", delayMs: 5 }] });
    const delay = (delayMs: number | "") => {
      const saved = fromStepDraft({ ...draft, keys: [{ ...draft.keys![0], delayMs }] });
      return saved.kind === "type-keys" && saved.chunks[0].delayMs;
    };
    expect([delay(""), delay(2.6), delay(-3), delay(5)]).toEqual([0, 3, 0, 5]);
  });

  it("shows an empty step a row to type into, and stores it empty", () => {
    const step: AutomationStep = { kind: "type-keys", chunks: [], timing: "recorded" };
    const draft = toStepDraft(step);
    expect(draft.keys).toHaveLength(1);
    expect(fromStepDraft(draft)).toBe(step);
  });

  it("tells an automation that only types keys apart", () => {
    expect(onlyTypesKeys([toStepDraft(recorded)])).toBe(true);
    expect(onlyTypesKeys([toStepDraft(recorded), toStepDraft({ kind: "wait", delayMs: 1 })])).toBe(
      false
    );
    expect(onlyTypesKeys([])).toBe(false);
  });
});

describe("container drafts", () => {
  const step: AutomationStep = {
    kind: "conditional",
    condition: { left: "a", op: "eq", right: "b" },
    then: [],
    else: [{ kind: "wait", delayMs: 1 }],
  };

  it("drops the else key once the branch is empty", () => {
    const draft = toStepDraft(step);
    expect(fromStepDraft({ ...draft, lists: { ...draft.lists, else: [] } })).not.toHaveProperty(
      "else"
    );
  });

  it("duplicates a step with ids of its own and the same content", () => {
    const draft = toStepDraft(step);
    const copy = duplicateStepDraft(draft);
    expect(fromStepDraft(copy)).toEqual(step);
    expect(copy.uid).not.toBe(draft.uid);
    expect(copy.lists!.else![0].uid).not.toBe(draft.lists!.else![0].uid);
  });
});

describe("draftContentKey", () => {
  it("is equal for two drafts of one automation, and notices every kind of edit", () => {
    for (const a of golden) {
      expect(draftContentKey(toDraft(a))).toBe(draftContentKey(toDraft(a)));
    }
    const a = golden.find((x) => x.name === "Deploy prep")!;
    const draft = toDraft(a);
    const key = draftContentKey(draft);
    const edits = [
      { ...draft, name: "x" },
      { ...draft, description: "x" },
      { ...draft, tags: "x" },
      { ...draft, triggersEnabled: false },
      { ...draft, triggers: [] },
      { ...draft, parameters: [] },
      { ...draft, steps: [...draft.steps].reverse() },
      { ...draft, steps: draft.steps.slice(1) },
    ];
    for (const edit of edits) expect(draftContentKey(edit)).not.toBe(key);
    const keys = toStepDraft({ kind: "type-keys", chunks: [{ data: "a", delayMs: 0 }] });
    const typed = { ...draft, steps: [keys] };
    const edited = { ...keys, keys: [{ ...keys.keys![0], text: "\\q" }] };
    expect(draftContentKey({ ...draft, steps: [edited] })).not.toBe(draftContentKey(typed));
  });
});

it("follows a renamed connection in every trigger, and is itself otherwise (#3603)", () => {
  const a = golden.find((x) => x.name === "Session hooks")!;
  const draft = toDraft(a);
  expect(remapDraftTriggers(draft, (id) => id)).toBe(draft);
  const moved = remapDraftTriggers(draft, (id) => (id === "conn-web-1" ? "Prod/web-1" : id));
  expect(fromDraft(moved, a).triggers).toEqual(
    JSON.parse(bytes(a.triggers).replaceAll('"conn-web-1"', '"Prod/web-1"'))
  );
});
