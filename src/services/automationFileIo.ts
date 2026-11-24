/**
 * Automations as files (#5818, slice 11): one export format, and one reader for
 * it and for everything older builds exported. **Pure**; the save and open
 * dialogs live in the UI.
 *
 * An export is `{ version, automations }`. A file may also hold the `macros` or
 * `workflows` list of an older build, or both (slices 6 to 8 wrote one such
 * file); their entries are converted on reading. An older build cannot read
 * `automations` and refuses the file without importing anything.
 *
 * ## Unknown keys
 *
 * Every entry is validated strictly (`workflowSchema.ts`), and the keys this
 * build does not know are kept, so a file from a newer build that added one
 * loses nothing. That is safe because an automation never carries a trust
 * decision: which local programs and script files may be used lives in the
 * settings, and {@link prepareAutomationImport} sets the Armed switch itself.
 */
import { child, isRecord } from "@/services/importEnvelope";
import { parseMacroEnvelope } from "@/services/macroIo";
import { WORKFLOW_EXPORT_VERSION, parseStepEntries } from "@/services/workflowIo";
import { referencedAutomations } from "@/services/automationRunner";
import { newId } from "@/services/transport/ids";
import { macroToAutomation, workflowToAutomation } from "@/store/slices/automationViews";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";

/** The lists a file may hold, in the order their entries are imported. */
const LIST_KEYS = ["automations", "macros", "workflows"] as const;
type ListKey = (typeof LIST_KEYS)[number];

/** The version of the export format. */
export const AUTOMATION_FILE_VERSION = WORKFLOW_EXPORT_VERSION;

/** Serialize automations into an export file. */
export function serializeAutomations(automations: readonly Automation[]): string {
  return `${JSON.stringify({ version: AUTOMATION_FILE_VERSION, automations }, null, 2)}\n`;
}

/**
 * `root` and every automation it runs, directly or through another one, so its
 * export is complete on another computer. One that does not exist is left out.
 */
export function withCalledAutomations(
  root: Automation,
  library: readonly Automation[]
): Automation[] {
  const included = new Map([[root.id, root]]);
  // A Map iterates entries added while it is walked.
  for (const automation of included.values()) {
    for (const id of referencedAutomations(automation.steps)) {
      const called = included.has(id) ? undefined : library.find((a) => a.id === id);
      if (called) included.set(id, called);
    }
  }
  return [...included.values()];
}

/** The automations a file holds, under the ids they have in it, per list. */
export type ParsedAutomationFile = Record<ListKey, Automation[]>;

/**
 * Add the keys of `raw` that validation dropped because this build does not know
 * them, at every level. A known key keeps its validated value.
 */
export function keepUnknownKeys<T>(validated: T, raw: unknown): T {
  if (Array.isArray(validated)) {
    return validated.map((item, i) => keepUnknownKeys(item, child(raw, i))) as T;
  }
  if (!isRecord(validated) || !isRecord(raw)) return validated;
  const unknown = Object.entries(raw).filter(([key]) => !(key in validated) && key !== "__proto__");
  const known = Object.entries(validated).map(([key, value]) => [
    key,
    keepUnknownKeys(value, child(raw, key)),
  ]);
  return Object.fromEntries([...known, ...unknown]) as T;
}

/** `entry`'s keys that its converted form does not have. */
function leftOver(entry: object, converted: object, dropped: readonly string[] = []): object {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !(key in converted) && !dropped.includes(key))
  );
}

/** Convert one entry of a `macros` list: its keys become one Type keys step. */
function fromMacroEntry(entry: ReturnType<typeof parseMacroEnvelope>[number]): Automation {
  const automation = macroToAutomation(entry);
  const steps = automation.steps.map((step) =>
    step.kind === "type-keys" ? { ...step, chunks: entry.steps } : step
  );
  return { ...leftOver(entry, automation), ...automation, steps };
}

/** Convert one entry of a `workflows` or `automations` list. */
function fromStepEntry(entry: ReturnType<typeof parseStepEntries>[number]): Automation {
  const automation = workflowToAutomation(entry);
  return { ...leftOver(entry, automation, ["parameters"]), ...automation };
}

/**
 * Read a file. Throws a readable error for malformed JSON, a file of a newer
 * termiHub, one without automations, or the first malformed entry, so a bad file
 * imports nothing.
 */
export function parseAutomationFile(json: string): ParsedAutomationFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid automations file: the file is not valid JSON.");
  }
  const lists = isRecord(parsed) ? LIST_KEYS.filter((key) => key in parsed) : [];
  const version = child(parsed, "version");
  if (typeof version === "number" && version > AUTOMATION_FILE_VERSION) {
    throw new Error(
      "The file was exported by a newer version of termiHub. Update termiHub to import it."
    );
  }
  if (lists.length === 0) {
    throw new Error("Invalid automations file: it holds no automations.");
  }
  const raw = (key: ListKey): unknown => child(parsed, key);
  const read = (key: "automations" | "workflows"): Automation[] =>
    lists.includes(key)
      ? keepUnknownKeys(parseStepEntries(json, key), raw(key)).map(fromStepEntry)
      : [];
  return {
    automations: read("automations"),
    macros: lists.includes("macros")
      ? keepUnknownKeys(parseMacroEnvelope(json), raw("macros")).map(fromMacroEntry)
      : [],
    workflows: read("workflows"),
  };
}

/** What an import brought in, and what the user should know about it. */
export interface AutomationImport {
  /** The automations to save, in file order. */
  automations: Automation[];
  /** The ones with triggers, which arrive switched off. */
  disarmed: string[];
  /** The ones with "Run local process" steps, which need the experimental switch. */
  localProcess: string[];
  /** The script files the file asked to read; the references were removed. */
  removedScriptPaths: { name: string; path: string }[];
  /**
   * The ones that run an automation the file does not hold. `runs` is the name
   * of the automation of this library with that very id, or `null`.
   */
  outside: { name: string; runs: string | null }[];
}

/** `name`, or `name (imported)`, `name (imported 2)`, … when it is taken. */
function importedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name} (imported)`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${name} (imported ${n})`;
  return candidate;
}

/** Rebuild a step list, nested steps included. */
function mapSteps(
  steps: readonly AutomationStep[],
  map: (step: AutomationStep) => AutomationStep
): AutomationStep[] {
  return steps.map((step) => {
    const next = map(step);
    if (next.kind === "conditional") {
      const then = mapSteps(next.then, map);
      return next.else ? { ...next, then, else: mapSteps(next.else, map) } : { ...next, then };
    }
    return next.kind === "loop" ? { ...next, body: mapSteps(next.body, map) } : next;
  });
}

/** Whether a step list holds a "Run local process" step, nested ones included. */
function hasLocalProcess(steps: readonly AutomationStep[]): boolean {
  let found = false;
  mapSteps(steps, (step) => {
    if (step.kind === "run-local-process") found = true;
    return step;
  });
  return found;
}

/**
 * Make a file's automations part of `library`:
 *
 * - a fresh id, so nothing is overwritten; a name that is taken becomes "… (imported)";
 * - steps that run an automation of the file run its imported copy. A step that
 *   runs one the file does not hold keeps its id and is reported: it is never
 *   matched by name;
 * - triggers, hotkeys included, are switched off (#5818): a file never decides
 *   what starts by itself;
 * - a script file to read from disk is removed (#4310, FEC2-001): a file never
 *   decides which local file is typed into a terminal;
 * - the migration's provenance is dropped, and the backend stamps the dates.
 */
export function prepareAutomationImport(
  file: ParsedAutomationFile,
  library: readonly Automation[],
  generateId: () => string = () => newId("automation")
): AutomationImport {
  const entries = LIST_KEYS.flatMap((key) => file[key]);
  const ids = entries.map(() => generateId());
  // The first entry with an id keeps it, as in the migration (concept 4.1).
  const copies = new Map<string, string>();
  entries.forEach(({ id }, i) => {
    if (id !== "" && !copies.has(id)) copies.set(id, ids[i]);
  });

  const names = new Set(library.map((a) => a.name));
  const result: AutomationImport = {
    automations: [],
    disarmed: [],
    localProcess: [],
    removedScriptPaths: [],
    outside: [],
  };
  entries.forEach((entry, i) => {
    const name = importedName(entry.name, names);
    names.add(name);
    const outside = new Set<string | null>();
    const steps = mapSteps(entry.steps, (step) => {
      if (step.kind === "run-automation") {
        const copy = copies.get(step.automationId);
        if (copy) return { ...step, automationId: copy };
        if (step.automationId !== "") {
          outside.add(library.find((a) => a.id === step.automationId)?.name ?? null);
        }
      }
      if (step.kind === "run-script" && step.sourcePath !== undefined) {
        const { sourcePath, ...rest } = step;
        result.removedScriptPaths.push({ name, path: sourcePath });
        // Nothing else may speak for the removed file either.
        return Object.fromEntries(
          Object.entries(rest).filter(([key]) => !key.startsWith("sourcePath"))
        ) as typeof rest;
      }
      return step;
    });
    outside.forEach((runs) => result.outside.push({ name, runs }));
    if (hasLocalProcess(steps)) result.localProcess.push(name);

    const { legacy: _legacy, triggersEnabled: _armed, ...kept } = entry;
    const automation: Automation = {
      ...kept,
      id: ids[i],
      name,
      steps,
      createdAt: "",
      updatedAt: "",
    };
    if (automation.triggers.length > 0) {
      automation.triggersEnabled = false;
      result.disarmed.push(name);
    }
    result.automations.push(automation);
  });
  return result;
}
