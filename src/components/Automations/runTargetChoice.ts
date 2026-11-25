/**
 * The run picker's target choice and the pure rules around it (#5818, slice 5).
 *
 * A choice names *how* the terminals are picked ("this terminal", "the
 * broadcast set", a saved group, a hand-picked list), not the terminals
 * themselves, so a remembered choice still means the same thing when tabs
 * open, close or reconnect. {@link resolveRunTargetChoice} turns it into the
 * live terminals it reaches right now.
 */

/** How the run picker chooses its terminals. */
export type RunTargetKind = "active" | "broadcast" | "panel" | "all" | "group" | "pick";

/** The run picker's choice: the kind plus what the kind needs. */
export interface RunTargetChoice {
  kind: RunTargetKind;
  /** The saved broadcast group, for `group`. */
  groupId?: string;
  /** The hand-picked terminal tab ids, for `pick`. */
  picked?: string[];
  /** Run several terminals at the same time (default) or one after another. */
  parallel: boolean;
}

/** One terminal tab the picker can offer. */
export interface RunTargetTerminal {
  /** The tab id. */
  id: string;
  /** The tab title. */
  title: string;
  /** Whether input typed now would reach it (connected, not taken over). */
  live: boolean;
  /** The machine it types into, and its tab group's name (A-035). */
  where: string;
  group: string;
}

/** Everything the picker offers right now, from the window's tabs. */
export interface RunTargetOptions {
  /** The active terminal tab, or `null` when the active tab is no terminal. */
  active: Omit<RunTargetTerminal, "where" | "group"> | null;
  /** Every terminal tab in this window, in tab order. */
  terminals: RunTargetTerminal[];
  /** The live broadcast set, or `null` when broadcast is off. */
  broadcast: string[] | null;
  /** The live terminals in the active terminal's panel (empty without one). */
  panel: string[];
  /** The live terminals of the current tab group. */
  all: string[];
  /** The current tab group's name (A-036). */
  groupName: string;
  /** The saved broadcast groups with their live member tabs. */
  groups: { id: string; name: string; tabIds: string[] }[];
}

/** The default choice: the active terminal, run in parallel. */
export const DEFAULT_RUN_TARGET_CHOICE: RunTargetChoice = { kind: "active", parallel: true };

/** The live terminals `choice` reaches right now, in tab order. A **pure** helper. */
export function resolveRunTargetChoice(
  choice: RunTargetChoice,
  options: RunTargetOptions
): string[] {
  switch (choice.kind) {
    case "active":
      return options.active?.live ? [options.active.id] : [];
    case "broadcast":
      return options.broadcast ?? [];
    case "panel":
      return options.panel;
    case "all":
      return options.all;
    case "group":
      return options.groups.find((g) => g.id === choice.groupId)?.tabIds ?? [];
    case "pick": {
      const picked = new Set(choice.picked ?? []);
      return options.terminals.filter((t) => t.live && picked.has(t.id)).map((t) => t.id);
    }
  }
}

/**
 * The choice the picker opens with: the remembered one while it still makes
 * sense, else the active terminal. A remembered broadcast set while broadcast
 * is off, a deleted group, or a panel without an active terminal falls back,
 * so the picker never opens on an option it does not show. A **pure** helper.
 */
export function initialRunTargetChoice(
  remembered: RunTargetChoice | null,
  options: RunTargetOptions
): RunTargetChoice {
  if (!remembered) return DEFAULT_RUN_TARGET_CHOICE;
  const fallback = { ...DEFAULT_RUN_TARGET_CHOICE, parallel: remembered.parallel };
  switch (remembered.kind) {
    case "broadcast":
      return options.broadcast ? remembered : fallback;
    case "panel":
      return options.active ? remembered : fallback;
    case "group":
      return options.groups.some((g) => g.id === remembered.groupId) ? remembered : fallback;
    default:
      return remembered;
  }
}

/**
 * The last choice made in this window, so the next open starts there
 * (#5818). Kept in memory for the app session only: termiHub keeps no UI
 * state in browser storage, and a multi-terminal run always asks to confirm
 * the terminals it names, so starting on a remembered set is safe.
 */
let rememberedChoice: RunTargetChoice | null = null;

/** The remembered choice, or `null` before the first run. */
export function rememberedRunTargetChoice(): RunTargetChoice | null {
  return rememberedChoice;
}

/** Remember `choice` for the next open. */
export function rememberRunTargetChoice(choice: RunTargetChoice): void {
  rememberedChoice = { ...choice, picked: choice.picked ? [...choice.picked] : undefined };
}

/** Forget the remembered choice (tests). */
export function resetRememberedRunTargetChoice(): void {
  rememberedChoice = null;
}
