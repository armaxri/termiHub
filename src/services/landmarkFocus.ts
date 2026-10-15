/**
 * F6 / Shift+F6 landmark cycling (#4773).
 *
 * Moves keyboard focus between the app shell's landmark regions — activity bar
 * (`<nav>`), sidebar (`<aside>`), terminal area (`<main>`) and status bar
 * (`<footer>`) — in a fixed order, wrapping around. A region that is not
 * rendered (hidden activity bar or status bar, collapsed sidebar) or holds
 * nothing focusable is skipped.
 *
 * The regions are resolved from the live DOM rather than store state so the
 * cycle always matches what is actually on screen, whichever side the activity
 * bar and sidebar are docked on.
 */
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getActivePanelId } from "@/store/layoutSelectors";

/** Identifiers of the shell landmark regions, in cycle order. */
export type LandmarkRegion = "activity-bar" | "sidebar" | "terminal" | "status-bar";

/** The landmark regions in F6 order, each with the selector of its root element. */
export const LANDMARK_REGIONS: readonly { region: LandmarkRegion; selector: string }[] = [
  { region: "activity-bar", selector: "nav.activity-bar" },
  { region: "sidebar", selector: "aside.sidebar" },
  { region: "terminal", selector: "main.terminal-view" },
  { region: "status-bar", selector: "footer.status-bar" },
];

/** Elements that can take keyboard focus. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

/** Whether `el` sits inside a subtree that is hidden from interaction. */
function isInertOrHidden(el: Element): boolean {
  return el.closest("[hidden], [inert], [aria-hidden='true']") !== null;
}

/** Focusable descendants of `root`, in document order, excluding hidden ones. */
function focusableWithin(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !isInertOrHidden(el)
  );
}

/**
 * Try each candidate in turn and keep the first that actually receives focus.
 * An element inside a `display: none` subtree (an inactive tab group) silently
 * refuses focus in a real browser, so the check keeps us from landing nowhere.
 */
function focusFirst(candidates: (HTMLElement | null | undefined)[]): boolean {
  for (const el of candidates) {
    if (!el) continue;
    el.focus();
    if (document.activeElement === el) return true;
  }
  return false;
}

/** Ask the active terminal (if the active tab is one) to take focus. */
function focusActiveTerminal(main: Element): boolean {
  const tab = getActiveTab(useAppStore.getState());
  if (!tab || tab.contentType !== "terminal") return false;
  window.dispatchEvent(new CustomEvent("termihub:focus-terminal", { detail: { tabId: tab.id } }));
  const active = document.activeElement;
  return active !== null && main.contains(active);
}

/** Focus the sensible entry point of the terminal area. */
function focusTerminalRegion(main: Element): boolean {
  if (focusActiveTerminal(main)) return true;
  const panelId = getActivePanelId();
  const activePanel = panelId
    ? Array.from(main.querySelectorAll("[data-testid^='panel-content-']")).find(
        (el) => el.getAttribute("data-testid") === `panel-content-${panelId}`
      )
    : undefined;
  const selectedTab = "[role='tab'][aria-selected='true']";
  return focusFirst([
    activePanel?.querySelector<HTMLElement>(selectedTab),
    main.querySelector<HTMLElement>(`.split-view-group--active ${selectedTab}`),
    main.querySelector<HTMLElement>(selectedTab),
    ...focusableWithin(main),
  ]);
}

/**
 * Move focus to the sensible entry point of `region`: the active activity-bar
 * item, the sidebar's first control, the active terminal (or the active tab),
 * or the first status-bar control. Returns whether focus landed in the region.
 */
export function focusLandmarkRegion(region: LandmarkRegion, root: Element): boolean {
  switch (region) {
    case "activity-bar":
      return focusFirst([
        root.querySelector<HTMLElement>(".activity-bar__item--active"),
        ...focusableWithin(root),
      ]);
    case "terminal":
      return focusTerminalRegion(root);
    case "sidebar":
    case "status-bar":
      return focusFirst(focusableWithin(root));
  }
}

/** The landmark regions currently rendered, in cycle order. */
function renderedRegions(): { region: LandmarkRegion; root: Element }[] {
  const out: { region: LandmarkRegion; root: Element }[] = [];
  for (const { region, selector } of LANDMARK_REGIONS) {
    const root = document.querySelector(selector);
    if (root && !isInertOrHidden(root)) out.push({ region, root });
  }
  return out;
}

/**
 * Whether focus is inside a modal surface (dialog, overlay, menu). F6 must not
 * pull focus out of a modal, which owns its own focus trap.
 */
function focusIsInModal(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return active.closest("[role='dialog'], [role='alertdialog'], [aria-modal='true']") !== null;
}

/**
 * Move focus to the next (`1`) or previous (`-1`) landmark region, wrapping
 * around and skipping regions that are absent or have nothing focusable.
 * From outside every region, forward starts at the first region and backward
 * at the last. Returns the region focus landed in, or `null` when nothing moved.
 */
export function cycleLandmarkFocus(delta: 1 | -1): LandmarkRegion | null {
  if (focusIsInModal()) return null;
  const regions = renderedRegions();
  if (regions.length === 0) return null;

  const active = document.activeElement;
  const currentIdx = active ? regions.findIndex(({ root }) => root.contains(active)) : -1;
  const n = regions.length;
  const startIdx = currentIdx === -1 ? (delta === 1 ? n - 1 : 0) : currentIdx;

  for (let step = 1; step <= n; step++) {
    const idx = (((startIdx + delta * step) % n) + n) % n;
    if (idx === currentIdx) break;
    const { region, root } = regions[idx];
    if (focusLandmarkRegion(region, root)) return region;
  }
  return null;
}
