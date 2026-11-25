/**
 * What a run nobody watches cannot do (#6024): a scheduled run never asks, so an
 * automation that asks for a value without a default does not start, and one that
 * meets a password prompt has nobody to answer it.
 */
import { reachesWaitForUser, visitSteps } from "@/services/automationRunner";
import type { WorkflowParamValues } from "@/services/workflowRunner";
import { isMacroShaped } from "@/store/slices/automationViews";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { WorkflowParameter } from "@/types/workflow";
import { t, tf } from "@/i18n/catalog";

/**
 * Parameter values for an unattended run: each parameter's default, else a
 * type-appropriate empty value. Returns the name of a required parameter that
 * has no usable default (the run must then not start, it cannot prompt).
 */
export function unattendedParamValues(
  parameters: readonly WorkflowParameter[]
): { values: WorkflowParamValues } | { missing: string } {
  const values: WorkflowParamValues = {};
  for (const param of parameters) {
    const value = param.default;
    const hasDefault = value !== undefined && !(typeof value === "string" && value.trim() === "");
    if (!hasDefault && param.required && param.type !== "boolean") {
      return { missing: param.label ?? param.name };
    }
    if (value !== undefined) {
      values[param.name] = value;
    } else if (param.type === "boolean") {
      values[param.name] = false;
    } else if (param.type === "enum") {
      values[param.name] = param.options?.[0] ?? "";
    } else {
      values[param.name] = "";
    }
  }
  return { values };
}

/** The step at which `automation` waits for the user, 1-based, or `null`. */
export function waitingStep(
  automation: Automation,
  resolve: (id: string) => Automation | undefined
): number | null {
  const index = automation.steps.findIndex((step) =>
    reachesWaitForUser({ ...automation, steps: [step] }, resolve)
  );
  return index < 0 ? null : index + 1;
}

/** Why an unattended run of `automation` does not start, or `null`. */
export function unattendedBlockedReason(
  automation: Automation,
  resolve: (id: string) => Automation | undefined
): string | null {
  if (isMacroShaped(automation)) return null;
  const waits = waitingStep(automation, resolve);
  if (waits !== null) return tf("schedule.unattended.waits", { step: waits });
  const params = unattendedParamValues(automation.parameters ?? []);
  return "missing" in params ? tf("schedule.unattended.missing", { name: params.missing }) : null;
}

/** The values an unattended run uses instead of asking, or `null` if it asks for none. */
export function unattendedDefaults(automation: Automation): string | null {
  const params = automation.parameters ?? [];
  const resolved = unattendedParamValues(params);
  if (params.length === 0 || "missing" in resolved) return null;
  const list = params.map((p) => {
    const value = String(resolved.values[p.name]);
    return `${p.label ?? p.name} = ${value === "" ? t("schedule.unattended.emptyValue") : value}`;
  });
  return tf("schedule.unattended.defaults", { list: list.join(", ") });
}

/** Commands that usually ask for a password when somebody types them. */
const ASKS_FOR_PASSWORD = /(?:^|[\n;&|(]\s*)(sudo|doas|su|passwd|kinit|ssh-add)(?=\s|$)/;
/** A pattern that waits for such a question; `[Pp]assword` too. */
const PASSWORD_PATTERN = /(?:p|\])ass(?:word|phrase|code)/i;

/** What `step` types into the terminal. */
function typedText(step: AutomationStep): string {
  switch (step.kind) {
    case "type-keys":
      return step.chunks
        .map((c) => c.data)
        .join("")
        .replace(/\r/g, "\n");
    case "send-command":
      return step.command;
    case "run-script":
      return step.script;
    default:
      return "";
  }
}

/**
 * A warning when `automation`, or one it runs, looks like it meets a password
 * prompt: it types `sudo` or the like, or waits for a password question. `null`
 * when nothing points to one; it may still meet one that cannot be seen here.
 */
export function unattendedPasswordNote(
  automation: Automation,
  resolve: (id: string) => Automation | undefined
): string | null {
  const seen = new Set<string>();
  const find = (next: Automation): string | null => {
    if (seen.has(next.id)) return null;
    seen.add(next.id);
    let note: string | null = null;
    visitSteps(next.steps, (step) => {
      if (note !== null) return;
      if (step.kind === "run-automation") {
        const called = resolve(step.automationId);
        if (called) note = find(called);
        return;
      }
      if (step.kind === "wait-for-output" && PASSWORD_PATTERN.test(step.pattern)) {
        note = t("schedule.unattended.passwordWait");
        return;
      }
      const command = ASKS_FOR_PASSWORD.exec(typedText(step as AutomationStep))?.[1];
      if (command) note = tf("schedule.unattended.password", { command });
    });
    return note;
  };
  return find(automation);
}
