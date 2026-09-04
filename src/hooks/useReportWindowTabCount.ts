import { useEffect } from "react";
import { getAllLeaves } from "@/utils/panelTree";
import { reportWindowTabCount } from "@/services/api";
import { useAppStore } from "@/store/appStore";
import { groupRenderTreesOf } from "@/store/layoutSelectors";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Report this window's live tab count to the backend window registry whenever it
 * changes (#1910).
 *
 * Tabs live in each window's own JS context, so a window cannot see another
 * window's count. Each window reports its own count here; the "Move to Window ▸"
 * picker in every *other* window reads the reported counts back (via
 * `list_windows`) to show a "N tabs" / "empty" hint sourced from real state.
 *
 * Mounted once at the app root. The count spans all of this window's tab groups
 * — the active group's live `rootPanel` plus the stored trees of the inactive
 * groups — matching how the window's own tabs are enumerated elsewhere.
 */
export function useReportWindowTabCount(): void {
  const tabCount = useAppStore((s) => {
    const trees = groupRenderTreesOf(s);
    return trees.reduce(
      (n, tree) => n + getAllLeaves(tree).reduce((m, leaf) => m + leaf.tabs.length, 0),
      0
    );
  });

  useEffect(() => {
    reportWindowTabCount(tabCount).catch((err) => {
      frontendLog("multi_window", `reportWindowTabCount failed: ${String(err)}`);
    });
  }, [tabCount]);
}
