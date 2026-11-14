import { t, tf } from "@/i18n/catalog";
import { tagsLine } from "@/components/SidebarListItem/rowTooltip";
import type { Macro, MacroRun } from "@/types/macro";
import { formatRelativeTime } from "@/utils/formatters";
import { MAX_PREVIEW_LINES, macroPreviewLines } from "./macroStepFormat";
import { macroRunTargetsText } from "./macroRunFormat";

/**
 * The macro row's tooltip lines (#5757): the lines it types (R-112), when and
 * where it last ran (#5680) and its tags. The row itself shows only the name
 * and the user's description: these are settings and history, not names.
 */
export function macroRowTooltip(macro: Macro, lastRun?: MacroRun): string[] {
  const lines = macroPreviewLines(macro.steps);
  const out: string[] = [];
  if (lines.length > 0) {
    out.push(t("macro.tooltip.types"), ...lines.slice(0, MAX_PREVIEW_LINES));
    if (lines.length > MAX_PREVIEW_LINES) out.push("…");
  }
  if (lastRun) {
    out.push(
      tf("macro.tooltip.lastRun", {
        when: formatRelativeTime(lastRun.endedAt),
        target: macroRunTargetsText(lastRun),
      })
    );
  }
  const tags = tagsLine(macro.tags);
  if (tags) out.push(tags);
  return out;
}
