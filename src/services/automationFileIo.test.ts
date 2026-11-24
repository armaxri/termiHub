import { describe, expect, it } from "vitest";
import { MACRO_EXPORT_VERSION, parseMacroEnvelope, serializeMacros } from "@/services/macroIo";
import {
  WORKFLOW_EXPORT_VERSION,
  parseWorkflowEnvelope,
  serializeWorkflows,
} from "@/services/workflowIo";
import type { Macro } from "@/types/macro";
import type { Workflow } from "@/types/workflow";
import { inspectAutomationFile, serializeAutomationLibrary } from "./automationFileIo";

const macro: Macro = {
  id: "m1",
  name: "Login",
  tags: ["ops"],
  steps: [{ data: "sudo -v\r", delayMs: 0 }],
  createdAt: "",
  updatedAt: "",
};
const workflow: Workflow = {
  id: "w1",
  name: "Deploy",
  tags: [],
  steps: [{ kind: "send-command", command: "make" }],
  triggers: [{ kind: "manual" }],
  createdAt: "",
  updatedAt: "",
};

describe("automation files (#5818, slice 6)", () => {
  it("shares one envelope version, so one file fits both importers", () => {
    expect(MACRO_EXPORT_VERSION).toBe(WORKFLOW_EXPORT_VERSION);
  });

  it("exports the whole library so each legacy importer still reads its list", () => {
    const json = serializeAutomationLibrary({ macros: [macro], workflows: [workflow] });
    expect(parseMacroEnvelope(json).map((m) => m.name)).toEqual(["Login"]);
    expect(parseWorkflowEnvelope(json).map((w) => w.name)).toEqual(["Deploy"]);
    expect(inspectAutomationFile(json)).toEqual({ macros: true, workflows: true });
  });

  it("recognises a file either old sidebar wrote", () => {
    expect(inspectAutomationFile(serializeMacros([macro]))).toEqual({
      macros: true,
      workflows: false,
    });
    expect(inspectAutomationFile(serializeWorkflows([workflow]))).toEqual({
      macros: false,
      workflows: true,
    });
  });

  it.each([
    ["malformed JSON", "{", /not valid JSON/],
    ["no list", '{"version":1}', /holds no automations/],
    ["not an object", "[]", /holds no automations/],
    ["a newer version", '{"version":9,"macros":[]}', /Unsupported macro file version/],
  ])("refuses %s", (_name, json, message) => {
    expect(() => inspectAutomationFile(json)).toThrow(message);
  });

  it("refuses the whole file when only one list is malformed", () => {
    const json = JSON.stringify({ version: 1, macros: [macro], workflows: [{ name: "" }] });
    expect(() => inspectAutomationFile(json)).toThrow(/Invalid workflow file/);
  });
});
