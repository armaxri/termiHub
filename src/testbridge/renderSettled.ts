/**
 * The `renderSettled` bridge query (#5643): has the screen finished rendering?
 *
 * The product run takes a window capture for every graded step. Lazy-loaded
 * surfaces (the connection and agent editors, Settings) first show a Suspense
 * spinner while their chunk loads, so a capture taken as soon as a testid
 * appeared could still show that spinner and the UI review graded it. This
 * query lets the harness wait until the screen is settled before it captures.
 */
import type { RenderSettledCommand, RenderSettledResult } from "./protocol";

/** Placeholders that mean "this surface has not rendered yet", wherever visible. */
export const PLACEHOLDER_SELECTOR = '[class*="lazy-fallback"], [class*="skeleton"]';

/** Busy indicators that block settling only inside the requested scope. */
export const BUSY_SELECTOR = '.ui-spinner, [aria-busy="true"]';

/** Terminal rows repaint on their own (cursor, output); their changes are ignored. */
const TERMINAL_SELECTOR = ".xterm";

/** How long one frame may take before it counts as throttled (occluded webview). */
export const FRAME_TIMEOUT_MS = 200;

const DEFAULT_FRAMES = 2;
const MAX_FRAMES = 10;

function escapeTestId(testId: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(testId)
    : testId.replace(/["\\]/g, "\\$&");
}

function allByTestId(root: ParentNode, testId: string): Element[] {
  return Array.from(root.querySelectorAll(`[data-testid="${escapeTestId(testId)}"]`));
}

/** Whether `el` is visible: a non-empty box on screen and not hidden by style. */
function isVisible(el: Element, view: Window): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= view.innerWidth || r.top >= view.innerHeight) {
    return false;
  }
  const style = view.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** A short evidence label for an element: its testid, else its first class. */
function describe(el: Element): string {
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId}"]`;
  const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  if (cls) return `.${cls}`;
  return el.tagName.toLowerCase();
}

/** Resolve after one animation frame; `true` when it timed out instead. */
function nextFrame(view: Window): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = view.setTimeout(() => {
      if (done) return;
      done = true;
      resolve(true);
    }, FRAME_TIMEOUT_MS);
    if (typeof view.requestAnimationFrame === "function") {
      view.requestAnimationFrame(() => {
        if (done) return;
        done = true;
        view.clearTimeout(timer);
        resolve(false);
      });
    }
  });
}

function insideTerminal(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(TERMINAL_SELECTOR) != null;
}

/**
 * Wait the requested frames while watching the DOM, then report whether the
 * screen under `root` is settled (see {@link RenderSettledCommand}).
 */
export async function renderSettled(
  root: ParentNode,
  command: RenderSettledCommand
): Promise<RenderSettledResult> {
  const doc = root instanceof Document ? root : ((root as Element).ownerDocument ?? document);
  const view = doc.defaultView ?? window;
  const frames = Math.min(Math.max(Math.trunc(command.frames ?? DEFAULT_FRAMES), 1), MAX_FRAMES);

  let mutations = 0;
  const count = (records: MutationRecord[]): void => {
    mutations += records.filter((r) => !insideTerminal(r.target)).length;
  };
  const observer = new MutationObserver(count);
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  let throttledFrames = 0;
  try {
    for (let i = 0; i < frames; i += 1) {
      if (await nextFrame(view)) throttledFrames += 1;
    }
  } finally {
    count(observer.takeRecords());
    observer.disconnect();
  }

  const reasons: string[] = [];
  const busy: string[] = [];

  for (const el of Array.from(root.querySelectorAll(PLACEHOLDER_SELECTOR))) {
    if (!isVisible(el, view)) continue;
    busy.push(describe(el));
    reasons.push(`a loading placeholder is visible (${describe(el)})`);
  }

  const scopes = command.scopeTestId
    ? allByTestId(root, command.scopeTestId).filter((s) => isVisible(s, view))
    : [];
  for (const el of Array.from(root.querySelectorAll(BUSY_SELECTOR))) {
    if (!isVisible(el, view)) continue;
    busy.push(describe(el));
    if (scopes.some((scope) => scope.contains(el))) {
      reasons.push(`a busy indicator is visible in ${command.scopeTestId} (${describe(el)})`);
    }
  }

  if (command.testId) {
    const matches = allByTestId(root, command.testId);
    if (matches.length === 0) {
      reasons.push(`${command.testId} is not in the page`);
    } else if (!matches.some((el) => isVisible(el, view))) {
      reasons.push(`${command.testId} is in the page but not visible`);
    }
  }
  if (command.scopeTestId && scopes.length === 0) {
    reasons.push(`${command.scopeTestId} is not visible`);
  }

  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts?.status ?? "unavailable";
  if (fonts === "loading") reasons.push("web fonts are still loading");

  if (mutations > 0) {
    reasons.push(`the page changed during the ${frames} idle frames (${mutations} DOM changes)`);
  }

  return { settled: reasons.length === 0, reasons, fonts, busy, mutations, throttledFrames };
}
