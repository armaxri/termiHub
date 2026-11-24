/**
 * The one "ask before closing a live session" choice (#5844).
 *
 * It replaced two overlapping switches — one for the close-tab shortcut, one
 * for pointer closes — whose interaction ("which wins on Cmd+W?") was unclear.
 * The single choice states it directly. The backend's v2 → v3 settings step
 * folds the two old flags into it without losing an opt-out
 * (`migrate_close_confirm` in `src-tauri/src/connection/settings.rs`).
 */
import type { AppSettings } from "@/types/connection";
import type { CloseLiveSessionConfirm } from "@/types/generated/CloseLiveSessionConfirm";

export type { CloseLiveSessionConfirm };

/** What started a close: a pointer gesture (X, middle-click, menu, panel close) or a shortcut. */
export type TabCloseTrigger = "pointer" | "shortcut";

/** The built-in default: ask for every close. */
export const DEFAULT_CLOSE_LIVE_SESSION_CONFIRM: CloseLiveSessionConfirm = "always";

/** Every choice, in the order the Settings select lists them. */
export const CLOSE_LIVE_SESSION_CONFIRM_CHOICES: readonly CloseLiveSessionConfirm[] = [
  "always",
  "shortcut",
  "pointer",
  "never",
];

/** The stored choice, or the default when it is unset or not a known value. */
export function resolveCloseConfirm(
  settings: Pick<AppSettings, "closeLiveSessionConfirm">
): CloseLiveSessionConfirm {
  const stored = settings.closeLiveSessionConfirm;
  return stored && CLOSE_LIVE_SESSION_CONFIRM_CHOICES.includes(stored)
    ? stored
    : DEFAULT_CLOSE_LIVE_SESSION_CONFIRM;
}

/** Whether `choice` asks before a close started by `trigger`. */
export function closeConfirmAsks(
  choice: CloseLiveSessionConfirm,
  trigger: TabCloseTrigger
): boolean {
  return choice === "always" || choice === trigger;
}

/** Whether the current settings ask before a close started by `trigger`. */
export function settingsAskBeforeClose(
  settings: Pick<AppSettings, "closeLiveSessionConfirm">,
  trigger: TabCloseTrigger
): boolean {
  return closeConfirmAsks(resolveCloseConfirm(settings), trigger);
}

/**
 * The choice after "Don't ask again" in a dialog raised by `trigger`: stop
 * asking for that kind of close only, so the other kind keeps its confirm.
 */
export function closeConfirmWithout(
  choice: CloseLiveSessionConfirm,
  trigger: TabCloseTrigger
): CloseLiveSessionConfirm {
  if (choice === "always") return trigger === "shortcut" ? "pointer" : "shortcut";
  return choice === trigger ? "never" : choice;
}
