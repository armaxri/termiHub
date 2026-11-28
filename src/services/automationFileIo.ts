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
 * ## A file is not trusted
 *
 * Every entry is validated (`workflowSchema.ts`) and only the keys this build
 * knows are taken: a forged marker never survives an import. Nothing is left out
 * silently, though. An entry that loses a key is reported by name, and one with a
 * step or trigger of a kind this build does not know, which it could only run
 * wrongly, is refused by name while the others are imported.
 */
import { child, isNonBlankString, isRecord } from "@/services/importEnvelope";
import { parseMacroEnvelope } from "@/services/macroIo";
import { WORKFLOW_EXPORT_VERSION, parseStepEntries } from "@/services/workflowIo";
import { KNOWN_ENTRY_KEYS, KNOWN_STEP_KINDS, KNOWN_TRIGGER_KINDS } from "@/services/workflowSchema";
import { triggerKindLabel } from "@/components/AutomationEditor/stepText";
import { referencedAutomations } from "@/services/automationRunner";
import { newId } from "@/services/transport/ids";
import { macroToAutomation, workflowToAutomation } from "@/store/slices/automationViews";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";

/** The lists a file may hold, in the order their entries are imported. */
const LIST_KEYS = ["automations", "macros", "workflows"] as const;
type ListKey = (typeof LIST_KEYS)[number];

/** The version of the export format. */
export const AUTOMATION_FILE_VERSION = WORKFLOW_EXPORT_VERSION;

/** Serialize automations into an export file. */
export function serializeAutomations(automations: readonly Automation[]): string {
  // What an import left out is about this library's copy, not the automation.
  const entries = automations.map(({ importedInPart: _importedInPart, ...entry }) => entry);
  return `${JSON.stringify({ version: AUTOMATION_FILE_VERSION, automations: entries }, null, 2)}\n`;
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

/** An entry of a file, under the id it has there. */
export interface ParsedEntry {
  automation: Automation;
  /** The parts of it this build does not know, which were left out: "a setting of step 2 (“later”)". */
  leftOut: string[];
}

/** What a file holds, per list. */
export interface ParsedAutomationFile {
  entries: Record<ListKey, ParsedEntry[]>;
  /** Entries of a newer build that were refused, and the kind that is not known. */
  refused: { name: string; kind: string }[];
}

/**
 * The first step or trigger kind of an entry that this build does not know, or
 * `null`. Anything else that is wrong is left to the validation.
 */
function unknownKind(raw: unknown): string | null {
  const search = (items: unknown, known: ReadonlySet<string>): string | null => {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
      const kind = child(item, "kind");
      if (typeof kind === "string" && !known.has(kind)) return kind;
      for (const nested of ["then", "else", "body"]) {
        const found = search(child(item, nested), known);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return (
    search(child(raw, "steps"), KNOWN_STEP_KINDS) ??
    search(child(raw, "triggers"), KNOWN_TRIGGER_KINDS)
  );
}

/**
 * What a part is and where (B-041): its key means nothing to the reader, so it says
 * "a setting of step 2 (“later”)".
 */
function partName(path: readonly (string | number)[]): string {
  const key = path[path.length - 1];
  const [list, index] = path;
  const what = (of: string) => `a setting${of} (“${key}”)`;
  if (path.length < 3 || typeof index !== "number") return what("");
  if (list === "steps") return what(` of step ${index + 1}`);
  if (list === "triggers") return what(` of trigger ${index + 1}`);
  return what(list === "parameters" ? ` of value ${index + 1}` : "");
}

/** The keys of `raw`, at any level, that validation took out. */
function leftOutParts(
  validated: unknown,
  raw: unknown,
  known: readonly string[] = [],
  path: readonly (string | number)[] = []
): string[] {
  if (Array.isArray(validated)) {
    return validated.flatMap((item, i) => leftOutParts(item, child(raw, i), [], [...path, i]));
  }
  if (!isRecord(validated) || !isRecord(raw)) return [];
  return Object.keys(raw).flatMap((key) => {
    if (key in validated) return leftOutParts(validated[key], raw[key], [], [...path, key]);
    return known.includes(key) ? [] : [partName([...path, key])];
  });
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
  const file = isRecord(parsed) ? parsed : {};
  const version = file.version;
  if (typeof version === "number" && version > AUTOMATION_FILE_VERSION) {
    throw new Error(
      "The file was exported by a newer version of termiHub. Update termiHub to import it."
    );
  }
  if (!LIST_KEYS.some((key) => key in file)) {
    throw new Error("Invalid automations file: it holds no automations.");
  }

  const refused: ParsedAutomationFile["refused"] = [];
  /** A list without the entries of a newer build. */
  const readable = (key: ListKey): unknown => {
    const list = file[key];
    if (!Array.isArray(list)) return list;
    return list.filter((raw: unknown) => {
      const kind = unknownKind(raw);
      const name = child(raw, "name");
      // Without a name there is nothing to refuse it by: the validation says so.
      if (kind === null || !isNonBlankString(name)) return true;
      refused.push({ name, kind });
      return false;
    });
  };
  const read = <T extends { name: string }>(
    key: ListKey,
    parse: (text: string) => T[],
    convert: (entry: T) => Automation
  ): ParsedEntry[] => {
    if (!(key in file)) return [];
    const list = readable(key);
    return parse(JSON.stringify({ version, [key]: list })).map((entry, i) => ({
      automation: convert(entry),
      leftOut: leftOutParts(entry, child(list, i), KNOWN_ENTRY_KEYS),
    }));
  };
  const entries = {
    automations: read(
      "automations",
      (t) => parseStepEntries(t, "automations"),
      workflowToAutomation
    ),
    macros: read("macros", parseMacroEnvelope, macroToAutomation),
    workflows: read("workflows", (t) => parseStepEntries(t, "workflows"), workflowToAutomation),
  };
  return { entries, refused };
}

/** One imported automation, and what the user should know about it. */
export interface ImportedEntry {
  automation: Automation;
  /** The parts this build does not know, which were left out. */
  leftOut: string[];
  /** The triggers it arrives with, hotkeys included; they are off. */
  triggersOff: string[];
  /** It has a "Run local process" step, which needs the experimental switch. */
  localProcess: boolean;
  /** The script files it asked to read; the references were removed. */
  removedScriptPaths: string[];
  /**
   * It runs automations the file does not hold: the name of the one of this
   * library with that very id, or `null`.
   */
  outside: (string | null)[];
  /** The name in the file, when that was taken and it was imported as a copy. */
  renamedFrom?: string;
}

/** What an import brought in. */
export interface AutomationImport {
  /** The automations to save, in file order. */
  automations: Automation[];
  /** The same, each with what to know about it. */
  entries: ImportedEntry[];
  /** Entries of a newer build that were not imported, and the kind not known. */
  refused: { name: string; kind: string }[];
}

/** A trigger in the dialog's words: "Hotkey F9", "On connect". */
function triggerName(trigger: AutomationTrigger): string {
  const label = triggerKindLabel(trigger.kind);
  return trigger.kind === "hotkey" && trigger.binding ? `${label} ${trigger.binding}` : label;
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
 * - the backend stamps the dates.
 */
export function prepareAutomationImport(
  file: ParsedAutomationFile,
  library: readonly Automation[],
  generateId: () => string = () => newId("automation")
): AutomationImport {
  const entries = LIST_KEYS.flatMap((key) => file.entries[key]);
  const ids = entries.map(() => generateId());
  // The first entry with an id keeps it, as in the migration (concept 4.1).
  const copies = new Map<string, string>();
  entries.forEach(({ automation: { id } }, i) => {
    if (id !== "" && !copies.has(id)) copies.set(id, ids[i]);
  });

  const names = new Set(library.map((a) => a.name));
  const result: AutomationImport = { automations: [], entries: [], refused: file.refused };
  entries.forEach(({ automation: entry, leftOut }, i) => {
    const name = importedName(entry.name, names);
    names.add(name);
    const outside = new Set<string | null>();
    const removedScriptPaths: string[] = [];
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
        removedScriptPaths.push(sourcePath);
        return rest;
      }
      return step;
    });

    const { triggersEnabled: _armed, ...kept } = entry;
    const automation: Automation = {
      ...kept,
      id: ids[i],
      name,
      steps,
      createdAt: "",
      updatedAt: "",
    };
    if (automation.triggers.length > 0) automation.triggersEnabled = false;
    // Its row says so until the user has looked at it and saved it (B-041).
    if (leftOut.length > 0) automation.importedInPart = leftOut;
    result.automations.push(automation);
    result.entries.push({
      automation,
      leftOut,
      triggersOff: automation.triggers.map(triggerName),
      localProcess: hasLocalProcess(steps),
      // Its name was taken: it is a copy under another name (live review files-1).
      ...(name !== entry.name ? { renamedFrom: entry.name } : {}),
      removedScriptPaths,
      outside: [...outside],
    });
  });
  return result;
}
