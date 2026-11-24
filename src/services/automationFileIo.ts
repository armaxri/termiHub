/**
 * The Automations sidebar's one Import and Export (#5818, slice 6), until slice
 * 11 gives automations an envelope of their own. An export of the whole library
 * carries both legacy lists in one file (`macros` and `workflows`), which either
 * older importer still reads; a file with either list, or both, imports. **Pure**.
 */
import { parseMacroEnvelope } from "@/services/macroIo";
import { WORKFLOW_EXPORT_VERSION, parseWorkflowEnvelope } from "@/services/workflowIo";
import { isRecord } from "@/services/importEnvelope";
import type { Macro } from "@/types/macro";
import type { Workflow } from "@/types/workflow";

/** Serialize the whole library as one file both legacy importers can read. */
export function serializeAutomationLibrary(library: {
  macros: Macro[];
  workflows: Workflow[];
}): string {
  // Both lists share the envelope's one `version`; a test fails if the two
  // formats ever drift apart.
  const envelope = {
    version: WORKFLOW_EXPORT_VERSION,
    macros: library.macros,
    workflows: library.workflows,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Which of the two lists an automations file holds. */
export interface AutomationFileLists {
  macros: boolean;
  workflows: boolean;
}

/**
 * Check a whole automations file before anything is saved and say which lists
 * it holds. Throws a readable error for malformed JSON, a file without either
 * list, or the first malformed entry of one, so a bad file imports nothing.
 */
export function inspectAutomationFile(json: string): AutomationFileLists {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid automations file: the file is not valid JSON.");
  }
  const lists = {
    macros: isRecord(parsed) && "macros" in parsed,
    workflows: isRecord(parsed) && "workflows" in parsed,
  };
  if (!lists.macros && !lists.workflows) {
    throw new Error("Invalid automations file: it holds no automations.");
  }
  if (lists.macros) parseMacroEnvelope(json);
  if (lists.workflows) parseWorkflowEnvelope(json);
  return lists;
}
