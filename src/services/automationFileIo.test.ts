import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import {
  AUTOMATION_FILE_VERSION,
  parseAutomationFile,
  prepareAutomationImport,
  serializeAutomations,
  withCalledAutomations,
  type AutomationImport,
} from "./automationFileIo";
import { MACRO_EXPORT_VERSION } from "./macroIo";

const TESTDATA = join(__dirname, "../../src-tauri/src/automations/testdata");
const testdata = (file: string) => readFileSync(join(TESTDATA, file), "utf8");
const golden = ["legacy.expected.json", "collision.expected.json"].map(
  (file) => (JSON.parse(testdata(file)) as { automations: Automation[] }).automations
);

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: "a",
    name: "Deploy",
    tags: [],
    steps: [{ kind: "send-command", command: "make" }],
    triggers: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

const runs = (automationId: string): AutomationStep => ({ kind: "run-automation", automationId });

/** Import a file's text into `library`, with ids n1, n2, … */
function importInto(library: Automation[], file: unknown): AutomationImport {
  let n = 0;
  const json = typeof file === "string" ? file : JSON.stringify(file);
  return prepareAutomationImport(parseAutomationFile(json), library, () => `n${++n}`);
}
const importFile = (file: unknown) => importInto([], file);
const exported = (...automations: Automation[]) => serializeAutomations(automations);

/** Every field of every kind. */
const EVERYTHING = {
  id: "all",
  name: "Everything",
  description: "every field",
  tags: ["ops"],
  steps: [
    {
      kind: "type-keys",
      chunks: [
        { data: "\u001b[200~grüße\r\n🚀\u001b[201~", delayMs: 0 },
        { data: "\u0003", delayMs: 1500 },
      ],
      timing: "fixed",
      fixedDelayMs: 25,
      recorded: true,
      continueOnError: true,
      retry: { count: 2, delayMs: 10, backoff: "exponential" },
    },
    { kind: "type-keys", chunks: [{ data: "x", delayMs: 3 }], timing: "instant" },
    { kind: "send-command", command: "echo ${env}" },
    { kind: "run-script", script: "a\nb", perLineDelayMs: 5 },
    { kind: "wait", delayMs: 10 },
    { kind: "run-local-process", program: "echo", args: ["hi"] },
    { kind: "wait-for-output", pattern: "\\$ $", isRegex: true, timeoutMs: 5000 },
    {
      kind: "conditional",
      condition: { left: "${env}", op: "eq", right: "prod" },
      then: [
        {
          kind: "loop",
          loop: { kind: "while", condition: { left: "1", op: "lt", right: "3" } },
          body: [{ kind: "wait", delayMs: 1 }],
        },
      ],
      else: [{ kind: "loop", loop: { kind: "count", count: 2 }, body: [runs("all")] }],
    },
  ],
  triggers: [
    { kind: "on-connect", connectionIds: ["c"] },
    { kind: "hotkey", binding: "Ctrl+Alt+D" },
    { kind: "on-disconnect", connectionIds: ["c"], when: "any" },
    {
      kind: "on-output-match",
      connectionIds: ["c"],
      pattern: "ERROR",
      isRegex: false,
      cooldownMs: 1000,
      maxFiresPerSession: 4,
    },
  ],
  parameters: [
    { name: "env", label: "Env", type: "enum", default: "dev", required: true, options: ["dev"] },
    { name: "n", type: "number" },
  ],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
} as unknown as Automation;

describe("export → import", () => {
  it("is one versioned list", () => {
    const json = exported(automation());
    expect(JSON.parse(json)).toEqual({ version: 1, automations: [automation()] });
    expect(json.endsWith("\n")).toBe(true);
    expect(AUTOMATION_FILE_VERSION).toBe(MACRO_EXPORT_VERSION);
  });

  it("loses nothing: every field, every nested step, every byte", () => {
    const [copy] = importFile(exported(EVERYTHING)).automations;
    const expected = JSON.parse(JSON.stringify(EVERYTHING));
    expected.steps[7].else[0].body[0].automationId = "n1"; // runs its own copy
    expect(importFile(exported(EVERYTHING)).leftOut).toEqual([]);
    expect(copy).toEqual({
      ...expected,
      id: "n1",
      triggersEnabled: false,
      createdAt: "",
      updatedAt: "",
    });
  });

  it.each(golden.map((list, i) => [i, list] as const))(
    "keeps what the app stores (golden file %i)",
    (_i, list) => {
      const result = importFile(exported(...list));
      const ids = new Map(list.map((a, i) => [a.id, `n${i + 1}`]));
      // Its own copies, and no script file: an import never reads one unasked.
      const repointed = JSON.parse(JSON.stringify(list), (key, value: unknown) =>
        key === "sourcePath"
          ? undefined
          : key === "automationId"
            ? (ids.get(String(value)) ?? value)
            : value
      ) as Automation[];
      result.automations.forEach((copy, i) => {
        const { legacy: _legacy, ...stored } = repointed[i];
        expect(copy).toMatchObject({ steps: stored.steps, triggers: stored.triggers });
        expect(copy.parameters).toEqual(stored.parameters);
        expect(copy.tags).toEqual(stored.tags);
        expect(copy.description).toBe(stored.description);
        expect(copy).not.toHaveProperty("legacy");
      });
      expect(result.automations).toHaveLength(list.length);
    }
  );

  it("survives a second round trip unchanged", () => {
    const [first] = importFile(exported(EVERYTHING)).automations;
    const [second] = importFile(exported(first)).automations;
    expect({ ...second, name: "" }).toEqual({ ...first, name: "" });
  });

  it("exports one automation with every automation it runs, once", () => {
    const a = automation({ id: "a", steps: [runs("b"), runs("gone")] });
    const b = automation({
      id: "b",
      steps: [
        { kind: "loop", loop: { kind: "count", count: 2 }, body: [runs("c")] },
        runs("a"), // a cycle ends
      ],
    });
    const c = automation({ id: "c" });
    const other = automation({ id: "other" });
    expect(withCalledAutomations(a, [other, c, b, a]).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(withCalledAutomations(other, [a, b, c, other])).toEqual([other]);
  });
});

describe("files of older builds", () => {
  const macro = {
    id: "m1",
    name: "Login",
    description: "logs in",
    tags: ["ops"],
    steps: [
      { data: "sudo -v", delayMs: 0 },
      { data: "\r", delayMs: 250 },
    ],
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "",
  };
  const workflow = {
    id: "w1",
    name: "Release",
    tags: [],
    steps: [
      { kind: "run-macro", macroId: "m1", continueOnError: true },
      {
        kind: "conditional",
        condition: { left: "a", op: "eq", right: "a" },
        then: [
          {
            kind: "loop",
            loop: { kind: "count", count: 1 },
            body: [{ kind: "run-macro", macroId: "m1" }],
          },
        ],
      },
    ],
    triggers: [{ kind: "manual" }, { kind: "on-connect", connectionIds: ["c"] }],
    parameters: [{ name: "p", type: "string" }],
    createdAt: "",
    updatedAt: "",
  };
  const keys: AutomationStep = {
    kind: "type-keys",
    chunks: [{ data: "sudo -v", delayMs: 0 } as never, { data: "\r", delayMs: 250 }],
    timing: "recorded",
    recorded: true,
  };

  it("a macro becomes an automation that types its keys as recorded", () => {
    expect(importFile({ version: 1, macros: [macro] }).automations).toEqual([
      {
        id: "n1",
        name: "Login",
        description: "logs in",
        tags: ["ops"],
        steps: [keys],
        triggers: [],
        createdAt: "",
        updatedAt: "",
      },
    ]);
  });

  it("a workflow keeps its steps, triggers and parameters", () => {
    const result = importFile({ version: 1, workflows: [workflow] });
    expect(result.automations[0]).toEqual({
      id: "n1",
      name: "Release",
      description: undefined,
      tags: [],
      steps: [
        { kind: "run-automation", automationId: "m1", continueOnError: true },
        {
          kind: "conditional",
          condition: { left: "a", op: "eq", right: "a" },
          then: [{ kind: "loop", loop: { kind: "count", count: 1 }, body: [runs("m1")] }],
        },
      ],
      triggers: [{ kind: "on-connect", connectionIds: ["c"] }],
      parameters: [{ name: "p", type: "string" }],
      triggersEnabled: false,
      createdAt: "",
      updatedAt: "",
    });
    expect(result.outside).toEqual([{ name: "Release", runs: null }]);
  });

  it("the one file with both lists, and its run steps run the imported copies", () => {
    // Slices 6 to 8 exported a run-automation step as run-macro, whatever it ran.
    const second = {
      ...workflow,
      id: "w2",
      name: "All",
      steps: [{ kind: "run-macro", macroId: "w1" }, keys],
      triggers: [{ kind: "manual" }],
    };
    const result = importFile({ version: 1, macros: [macro], workflows: [workflow, second] });
    const [login, release, all] = result.automations;
    expect(login.steps).toEqual([keys]);
    expect(release.steps[0]).toMatchObject({ kind: "run-automation", automationId: login.id });
    expect(JSON.stringify(release.steps[1])).toContain(`"automationId":"${login.id}"`);
    expect(all.steps).toEqual([runs(release.id), keys]);
    expect(result.outside).toEqual([]);
  });

  it.each(["legacy", "collision"])("every stored workflow of the %s fixture", (kind) => {
    const { workflows } = JSON.parse(testdata(`workflows_${kind}.json`)) as {
      workflows: unknown[];
    };
    const result = importFile({ version: 1, workflows });
    expect(result.automations).toHaveLength(workflows.length);
  });
});

describe("run steps", () => {
  it("run the imported copy, also when it comes later, nested, or is itself", () => {
    const result = importFile(
      exported(
        automation({ id: "a", steps: [runs("b"), runs("a")] }),
        automation({
          id: "b",
          name: "B",
          steps: [
            {
              kind: "conditional",
              condition: { left: "", op: "eq", right: "" },
              then: [],
              else: [runs("a")],
            },
          ],
        })
      )
    );
    expect(result.automations[0].steps).toEqual([runs("n2"), runs("n1")]);
    expect(JSON.stringify(result.automations[1])).toContain('"automationId":"n1"');
    expect(result.outside).toEqual([]);
  });

  it("that run one the file does not hold keep their id and are reported", () => {
    const library = [
      automation({ id: "here", name: "Cleanup" }),
      automation({ id: "x", name: "B" }),
    ];
    const result = importInto(
      library,
      exported(automation({ name: "New", steps: [runs("here"), runs("gone"), runs("gone")] }))
    );
    expect(result.automations[0].steps).toEqual([runs("here"), runs("gone"), runs("gone")]);
    expect(result.outside).toEqual([
      { name: "New", runs: "Cleanup" },
      { name: "New", runs: null },
    ]);
  });

  it("are never matched by name", () => {
    const library = [automation({ id: "other-id", name: "Cleanup" })];
    const result = importInto(
      library,
      exported(automation({ name: "New", steps: [runs("Cleanup")] }))
    );
    expect(result.outside).toEqual([{ name: "New", runs: null }]);
  });

  it("without a chosen automation are left alone", () => {
    const result = importFile(exported(automation({ steps: [runs("")] })));
    expect(result.automations[0].steps).toEqual([runs("")]);
    expect(result.outside).toEqual([]);
  });

  it("with an id two entries share run the first", () => {
    const result = importFile(
      exported(
        automation({ name: "1" }),
        automation({ name: "2" }),
        automation({ id: "c", steps: [runs("a")] })
      )
    );
    expect(result.automations[2].steps).toEqual([runs("n1")]);
  });
});

describe("an import is never trusted", () => {
  it.each<[string, Automation["triggers"]]>([
    ["a connection", [{ kind: "on-connect", connectionIds: ["c"] }]],
    ["a hotkey", [{ kind: "hotkey", binding: "Enter" }]],
  ])("arrives switched off when it has a trigger: %s", (_name, triggers) => {
    const result = importFile(exported(automation({ triggers, triggersEnabled: true })));
    expect(result.automations[0]).toMatchObject({ triggers, triggersEnabled: false });
    expect(result.disarmed).toEqual(["Deploy"]);
  });

  it("without a trigger has nothing to switch off", () => {
    const result = importFile(exported(automation({ triggersEnabled: false })));
    expect(result.automations[0]).not.toHaveProperty("triggersEnabled");
    expect(result.disarmed).toEqual([]);
  });

  it("names the ones that run a local program, nested ones too, and keeps the step", () => {
    const step: AutomationStep = { kind: "run-local-process", program: "rm", args: ["-rf"] };
    const nested: AutomationStep = {
      kind: "loop",
      loop: { kind: "count", count: 1 },
      body: [
        {
          kind: "conditional",
          condition: { left: "", op: "eq", right: "" },
          then: [],
          else: [step],
        },
      ],
    };
    const result = importFile(
      exported(automation({ name: "A", steps: [step] }), automation({ name: "B", steps: [nested] }))
    );
    expect(result.localProcess).toEqual(["A", "B"]);
    expect(result.automations[1].steps).toEqual([nested]);
  });

  it("drops every script file reference and anything that speaks for it", () => {
    const script = {
      kind: "run-script",
      script: "echo hi",
      sourcePath: "/home/u/.ssh/id_ed25519",
      sourcePathConfirmed: true,
    } as AutomationStep;
    const nested: AutomationStep = {
      kind: "loop",
      loop: { kind: "count", count: 1 },
      body: [script],
    };
    const result = importFile(exported(automation({ steps: [script, nested] })));
    const clean = { kind: "run-script", script: "echo hi" };
    expect(result.automations[0].steps).toEqual([clean, { ...nested, body: [clean] }]);
    expect(result.removedScriptPaths).toEqual([
      { name: "Deploy", path: "/home/u/.ssh/id_ed25519" },
      { name: "Deploy", path: "/home/u/.ssh/id_ed25519" },
    ]);
  });

  it("gets fresh ids and free names, and overwrites nothing", () => {
    const library = [automation({ id: "a", name: "Deploy" })];
    const result = importInto(
      library,
      exported(automation({ id: "a" }), automation({ id: "b" }), automation({ id: "c", name: "X" }))
    );
    expect(result.automations.map((a) => [a.id, a.name])).toEqual([
      ["n1", "Deploy (imported)"],
      ["n2", "Deploy (imported 2)"],
      ["n3", "X"],
    ]);
  });

  it("cannot reach an object's prototype", () => {
    const json = `{"version":1,"automations":[{"name":"X","steps":[],"__proto__":{"polluted":1}}]}`;
    const [copy] = importFile(json).automations;
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect((copy as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a bad file imports nothing", () => {
  it.each([
    ["malformed JSON", "{", /not valid JSON/],
    ["no list", '{"version":1}', /holds no automations/],
    ["not an object", "[]", /holds no automations/],
    ["a newer version", '{"version":9,"automations":[]}', /newer version of termiHub/],
    ["no version", '{"automations":[]}', /Unsupported automation file version/],
    ["a list that is none", '{"version":1,"automations":{}}', /missing "automations" array/],
    ["an unnamed entry", '{"version":1,"automations":[{"steps":[]}]}', /missing a name/],
    [
      "an unnamed entry of a newer build",
      '{"version":1,"automations":[{"steps":[{"kind":"teleport"}]}]}',
      /missing a name/,
    ],
  ])("%s", (_name, json, message) => {
    expect(() => parseAutomationFile(json)).toThrow(message);
  });

  it.each(["automations", "macros", "workflows"])("when only %s is malformed", (bad) => {
    const file = { version: 1, automations: [], macros: [], workflows: [], [bad]: [{ name: "" }] };
    expect(() => parseAutomationFile(JSON.stringify(file))).toThrow(/Invalid/);
  });
});

describe("a file of a newer build", () => {
  it.each<[string, object]>([
    ["the automation", { later: true }],
    ["a step", { steps: [{ kind: "wait", delayMs: 1, later: 1 }] }],
    ["a chunk", { steps: [{ kind: "type-keys", chunks: [{ data: "x", delayMs: 0, later: 1 }] }] }],
    [
      "a nested step",
      {
        steps: [
          {
            kind: "loop",
            loop: { kind: "count", count: 1 },
            body: [{ kind: "wait", delayMs: 1, retry: { count: 1, later: 1 } }],
          },
        ],
      },
    ],
    ["a trigger", { triggers: [{ kind: "hotkey", binding: "F8", later: 1 }] }],
    ["a value it asks for", { parameters: [{ name: "p", type: "string", later: 1 }] }],
  ])("loses an unknown key of %s, and says so by name", (_where, over) => {
    const result = importFile(
      exported(automation({ ...over, name: "New" } as Partial<Automation>))
    );
    expect(result.leftOut).toEqual(["New"]);
    expect(JSON.stringify(result.automations)).not.toContain("later");
  });

  it("says so for old lists too, and only for the entry it is true of", () => {
    const macro = { name: "M", steps: [{ data: "x", delayMs: 0 }] };
    const result = importFile({
      version: 1,
      macros: [macro, { ...macro, name: "N", later: 1 }],
      workflows: [{ name: "W", steps: [{ kind: "wait", delayMs: 1, later: 1 }] }],
    });
    expect(result.leftOut).toEqual(["N", "W"]);
  });

  it("says nothing about what an import sets itself", () => {
    const result = importFile(
      exported(
        automation({
          triggersEnabled: true,
          parameters: [],
          legacy: { from: "macro", version: 1 },
        })
      )
    );
    expect(result.leftOut).toEqual([]);
    expect(result.automations[0]).not.toHaveProperty("legacy");
  });

  it.each<[string, object, string]>([
    ["a step", { steps: [{ kind: "teleport", to: "x" }] }, "teleport"],
    [
      "a nested step",
      {
        steps: [
          { kind: "wait", delayMs: 1 },
          {
            kind: "conditional",
            condition: { left: "", op: "eq", right: "" },
            then: [],
            else: [{ kind: "loop", loop: { kind: "count", count: 1 }, body: [{ kind: "zap" }] }],
          },
        ],
      },
      "zap",
    ],
    ["a trigger", { triggers: [{ kind: "on-full-moon" }] }, "on-full-moon"],
  ])(
    "refuses the entry with an unknown kind of %s by name, and takes the rest",
    (_w, over, kind) => {
      const odd = automation({ ...over, id: "odd", name: "Odd" } as Partial<Automation>);
      const result = importFile(
        exported(
          automation({ id: "a" }),
          odd,
          automation({ id: "c", name: "C", steps: [runs("odd")] })
        )
      );
      expect(result.refused).toEqual([{ name: "Odd", kind }]);
      expect(result.automations.map((a) => a.name)).toEqual(["Deploy", "C"]);
      // What runs the refused one is not left to fail unannounced.
      expect(result.outside).toEqual([{ name: "C", runs: null }]);
    }
  );

  it("with a kind named like something every object has is refused too", () => {
    const odd = automation({ steps: [{ kind: "constructor" }] as never });
    expect(importFile(exported(odd)).refused).toEqual([{ name: "Deploy", kind: "constructor" }]);
  });
});
