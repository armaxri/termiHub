/**
 * `useLayoutRenderTree` — the renderer's handle on the active tab group's panel
 * tree (#2151, part of #2139; finalized in #2283 slice E2; fields deleted #2562).
 *
 * `SplitView` renders the active group's tree. Since the layout mirror-field
 * deletion (#2562), `appStore` stores only the raw `layout@<clientId>` view; the
 * rich tree is composed on demand from it plus the by-id tab content and the
 * relocated split marks. The composition is memoized on those inputs' identities
 * (`getComposedLayout`), so this selector returns a stable reference across
 * unrelated store changes — no render storm.
 */

import { getComposedLayout, useAppStore } from "@/store/appStore";
import type { PanelNode } from "@/types/terminal";

/** The active tab group's panel tree for rendering — composed from the region view. */
export function useLayoutRenderTree(): PanelNode {
  return useAppStore((s) => getComposedLayout(s).rootPanel);
}
