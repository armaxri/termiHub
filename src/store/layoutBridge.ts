/**
 * Layout projection bridge — Phase 3 steps 2–3 of the stateless-UI migration
 * (#2151, part of #2139).
 *
 * Step 1 landed a shadow, backend-authoritative `LayoutStore` served as the
 * client-scoped `layout@<clientId>` projection region, but nothing in the UI
 * touched it. Step 2 makes the store authoritative for **panel-tree structure**:
 * the four structural mutations (split / move-tab / merge-a-tab / split-with-tab)
 * dispatch `layout.*` intents instead of editing `appStore.rootPanel` locally,
 * and the resulting projection diff is reconciled back into `appStore`'s
 * existing panel-tree shape so `SplitView` renders exactly as before.
 *
 * Step 3 cuts **rendering** over: the render helpers below
 * ({@link viewMatchesTree}, {@link composeRenderTree}, {@link seedLayoutRegion})
 * let {@link import("./useLayoutRenderTree").useLayoutRenderTree} source the
 * renderer's panel/tab structure from the projected render-list (content still
 * overlaid from `appStore` — partial projection). The two cuts are gated
 * independently ({@link layoutIntentsEnabled} for mutations, off by default;
 * {@link layoutRenderFromProjectionEnabled} for rendering, on by default) so the
 * parity-safe render cut can ship live without the async mutation flip. The
 * appStore panel-tree reducers are removed in step 4.
 *
 * # Seed-before-mutate
 *
 * Under partial projection the region carries only structure + the minimal tab
 * model (`{ id, sessionId, contentType }`); tab **creation** still lives in
 * `appStore` (a session-coupled concern deferred to a later phase). The shadow
 * store is therefore never told about tabs on its own. So each structural
 * mutation first **seeds** the store with `appStore`'s current tree (in the
 * minimal-tab form) via `layout.replace`, then dispatches the transform. The
 * store thus mutates the real tree and projects a diff; the frontend
 * {@link reconcileNode reconciles} that minimal-tab diff back into rich
 * {@link TerminalTab}s by id (the xterm DOM is registered globally by tab id, so
 * a moved tab keeps its live session + scrollback). Seeding per-op also means
 * the store never drifts from `appStore` between ops.
 *
 * # Strangler safety
 *
 * The mutation cut is gated by {@link layoutIntentsEnabled} — **on by default**
 * since #2184 (verified parity-clean in a live GUI run). Any dispatch/reconcile
 * failure falls back to the local mutation, so a backend hiccup can never break
 * layout, and the flag can be set to `"false"` to restore the pre-cut local
 * reducers for rollback. The render cut
 * ({@link layoutRenderFromProjectionEnabled}, on by default) is separately safe:
 * it only composes from the projection when the view mirrors `appStore`'s tree,
 * else falls back to that tree verbatim.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type {
  DropEdge,
  LeafPanel,
  PanelNode,
  SplitContainer,
  TabContent,
  TerminalTab,
} from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";
import { findLeafByTab } from "@/utils/panelTree";

/** The structural result the bridge hands back to `appStore`. */
export interface LayoutStructuralResult {
  rootPanel: PanelNode;
  activePanelId: string | null;
}

// ── Minimal projected shapes (twins of the Rust `layout` view model) ──────────

interface MinimalTab {
  id: string;
  sessionId?: string | null;
  contentType: string;
}
interface MinimalLeaf {
  type: "leaf";
  id: string;
  tabs: MinimalTab[];
  activeTabId: string | null;
}
interface MinimalSplit {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: MinimalNode[];
  sizes?: number[];
  lastActiveLeafId?: string;
}
export type MinimalNode = MinimalLeaf | MinimalSplit;

/** The `layout@<clientId>` region view model: tree + focused panel. */
export interface LayoutView {
  root: MinimalNode;
  activePanelId: string | null;
}

// ── Feature flag (runtime-flippable so a dev build can verify the ON path) ─────

interface LayoutFlagWindow {
  __TERMIHUB_LAYOUT_INTENTS__?: boolean;
  __TERMIHUB_LAYOUT_RENDER__?: boolean;
  localStorage?: Storage;
}

let flagOverride: boolean | null = null;
let renderFlagOverride: boolean | null = null;

/**
 * Programmatic override for the layout-intents (mutation) flag (tests, and a
 * runtime toggle). `null` clears the override and falls back to the
 * window/localStorage signal, then to the default.
 */
export function setLayoutIntentsEnabled(value: boolean | null): void {
  flagOverride = value;
}

/**
 * Programmatic override for the render-from-projection flag (tests, runtime
 * toggle). `null` clears it and falls back to the window/localStorage signal,
 * then to the default.
 */
export function setLayoutRenderFromProjectionEnabled(value: boolean | null): void {
  renderFlagOverride = value;
}

/** Read a boolean feature signal from `window`/`localStorage`, else `dflt`. */
function readFlag(
  override: boolean | null,
  windowKey: keyof LayoutFlagWindow,
  storageKey: string,
  dflt: boolean
): boolean {
  if (override !== null) return override;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as LayoutFlagWindow;
      const wv = w[windowKey];
      if (typeof wv === "boolean") return wv;
      const ls = w.localStorage?.getItem(storageKey);
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return dflt;
}

/**
 * Whether structural layout **mutations** route through `layout.*` intents
 * (step 2) instead of editing `appStore.rootPanel` locally.
 *
 * **On by default** (#2184). The backend `LayoutStore` is authoritative for
 * mutations: split/move/merge run as asynchronous backend round-trips, with the
 * projected diff reconciled back into `appStore` by {@link reconcileNode}. The
 * behavioural (timing) change was verified parity-clean in a live GUI run before
 * flipping — split, drag-to-edge, drag-to-center, tab-move across panels, and
 * merge, with live-terminal scrollback surviving every op. Any dispatch/reconcile
 * failure still falls back to the local reducer, so a backend hiccup can never
 * break layout. Overridable at runtime for rollback / tests via
 * `window.__TERMIHUB_LAYOUT_INTENTS__` or `localStorage["termihub.layoutIntents"]`
 * (set `"false"` to restore the pre-cut local-mutation path).
 */
export function layoutIntentsEnabled(): boolean {
  return readFlag(flagOverride, "__TERMIHUB_LAYOUT_INTENTS__", "termihub.layoutIntents", true);
}

/**
 * Whether the **renderer** sources its panel/tab structure from the projected
 * `layout@<clientId>` render-list (step 3,
 * {@link import("./useLayoutRenderTree").useLayoutRenderTree}) rather than from
 * `appStore.rootPanel` directly.
 *
 * **On by default.** Parity-safe by construction: the renderer composes from the
 * projection only when its view structurally mirrors `appStore`'s tree, and
 * otherwise falls back to that tree verbatim — so the rendered output is always
 * identical to the pre-cut renderer, and live xterm DOM is reparented (never
 * remounted) because tab/panel ids are preserved. Independent of the mutation
 * cut: the region is seeded from `appStore` whether mutations are local or
 * intent-routed. Overridable for rollback / an A-B check (the renderer reads it
 * at mount, so a flip takes effect on reload) via
 * `window.__TERMIHUB_LAYOUT_RENDER__` or `localStorage["termihub.layoutRender"]`.
 */
export function layoutRenderFromProjectionEnabled(): boolean {
  return readFlag(renderFlagOverride, "__TERMIHUB_LAYOUT_RENDER__", "termihub.layoutRender", true);
}

// ── Transport + region client (lazy, mirrors the tunnel slice) ─────────────────

// A stable per-session client identity. The client-scoped region is
// `layout@<clientId>`, and dispatched intents carry the same id, so this
// checkout mutates and subscribes to its own layout region.
const clientId = newClientId();
const region = `layout@${clientId}`;

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

function transport(): Transport {
  if (!transportInstance) {
    transportInstance = createTransport();
  }
  return transportInstance;
}

/**
 * Ensure the `layout@<clientId>` region client is subscribed, so intent diffs
 * are received. Idempotent and de-duplicated across concurrent callers.
 */
function ensureSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), region);
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        throw err;
      });
  }
  return startPromise;
}

async function dispatch(kind: string, payload: unknown): Promise<IntentAck> {
  return transport().dispatch({ intentId: newIntentId(), kind, payload, clientId });
}

function throwIfRejected(ack: IntentAck, what: string): void {
  if (ack.status === "rejected") {
    throw new Error(ack.error?.message ?? `layout intent ${what} rejected`);
  }
}

// ── Tree mapping: rich ⇄ minimal, and reconcile ──────────────────────────────

/** Strip a rich panel tree down to the minimal projected form for seeding. */
export function toMinimalNode(node: PanelNode): MinimalNode {
  if (node.type === "leaf") {
    return {
      type: "leaf",
      id: node.id,
      tabs: node.tabs.map((t) => ({
        id: t.id,
        sessionId: t.sessionId ?? null,
        contentType: t.contentType,
      })),
      activeTabId: node.activeTabId,
    };
  }
  const split: MinimalSplit = {
    type: "split",
    id: node.id,
    direction: node.direction,
    children: node.children.map(toMinimalNode),
  };
  if (node.sizes) split.sizes = node.sizes;
  if (node.lastActiveLeafId) split.lastActiveLeafId = node.lastActiveLeafId;
  return split;
}

/** Index every rich tab in a tree by id, for reconcile lookups. */
export function collectTabs(node: PanelNode): Map<string, TerminalTab> {
  const map = new Map<string, TerminalTab>();
  const walk = (n: PanelNode): void => {
    if (n.type === "leaf") {
      for (const t of n.tabs) map.set(t.id, t);
    } else {
      n.children.forEach(walk);
    }
  };
  walk(node);
  return map;
}

/**
 * Rebuild a rich {@link PanelNode} from a projected minimal tree, re-attaching
 * each tab's rich fields by id (partial projection: the region carries only
 * structure + minimal tab identity). Per-leaf, `panelId` and `isActive` are
 * re-derived from the projected structure — exactly what the old local reducers
 * set — so `SplitView`'s selectors see an identical shape.
 *
 * **Content source (part of #2283).** A tab's non-structural content is read
 * from `contentById` — the flat by-id {@link TabContent} map that is becoming
 * the authoritative content store as the tree thins — and **falls back** to the
 * in-tree rich {@link TerminalTab} in `tabsById` when the id is absent from the
 * map. In this behavior-preserving slice the map merely *duplicates* content the
 * tree still holds, so both sources agree; the fallback keeps tabs that are not
 * yet in the map (e.g. editor/settings tabs) rendering exactly as before.
 * `contentById` is optional so the structural write-back path
 * ({@link runLayoutIntent}) keeps reconstructing straight from the tree.
 *
 * Throws if the projection references a tab absent from **both** sources; the
 * caller treats that as a bridge failure and falls back to the local mutation.
 */
export function reconcileNode(
  node: MinimalNode,
  tabsById: Map<string, TerminalTab>,
  contentById?: Record<string, TabContent>
): PanelNode {
  if (node.type === "leaf") {
    const tabs: TerminalTab[] = node.tabs.map((mt) => {
      const base = contentById?.[mt.id] ?? tabsById.get(mt.id);
      if (!base) {
        throw new Error(`layout reconcile: unknown tab ${mt.id}`);
      }
      return { ...base, panelId: node.id, isActive: mt.id === node.activeTabId };
    });
    const leaf: LeafPanel = {
      type: "leaf",
      id: node.id,
      tabs,
      activeTabId: node.activeTabId,
    };
    return leaf;
  }
  const split: SplitContainer = {
    type: "split",
    id: node.id,
    direction: node.direction,
    children: node.children.map((c) => reconcileNode(c, tabsById, contentById)),
  };
  if (node.sizes) split.sizes = node.sizes;
  if (node.lastActiveLeafId) split.lastActiveLeafId = node.lastActiveLeafId;
  return split;
}

// ── Await a region version, then read the reconciled tree ─────────────────────

/** Resolve once the region client has caught up to (at least) `version`. */
function awaitVersion(client: ProjectionClient, version: number, timeoutMs = 4000): Promise<void> {
  if (client.state.version >= version) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`layout region did not reach version ${version} in time`));
    }, timeoutMs);
    const unsubscribe = client.onChange((state) => {
      if (state.version >= version) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Run a structural layout mutation through the store: seed the store with the
 * current tree, dispatch `kind`, await the resulting diff, and reconcile it back
 * into `appStore`'s rich panel-tree shape.
 *
 * The backend `move_tab` transform does not repoint the focused panel, but the
 * old local move/split-with-tab reducers all focus the tab's destination. So
 * when `focusTabId` is given, the reconciled `activePanelId` is re-derived as
 * the panel that now holds that tab — reproducing the old focus behaviour.
 *
 * @param kind        the `layout.*` intent kind
 * @param payload     the intent payload
 * @param root        `appStore`'s current `rootPanel` (authoritative structure)
 * @param active      `appStore`'s current `activePanelId`
 * @param focusTabId  when set, focus the panel this tab landed in
 * @returns the reconciled `{ rootPanel, activePanelId }` to apply to `appStore`
 * @throws  on a rejected/failed intent or an unreconcilable diff (caller falls
 *          back to the local mutation)
 */
export async function runLayoutIntent(
  kind: string,
  payload: Record<string, unknown>,
  root: PanelNode,
  active: string | null,
  focusTabId?: string
): Promise<LayoutStructuralResult> {
  const client = await ensureSubscribed();
  const tabsById = collectTabs(root);

  // Seed the store with appStore's authoritative tree, then transform it.
  throwIfRejected(
    await dispatch("layout.replace", { root: toMinimalNode(root), activePanelId: active }),
    "replace"
  );
  const ack = await dispatch(kind, payload);
  throwIfRejected(ack, kind);

  const produced = ack.produced?.find((p) => p.region === region);
  if (produced) {
    await awaitVersion(client, produced.version);
  }

  const view = client.state.view as LayoutView | undefined;
  if (!view || !view.root) {
    throw new Error("layout region has no view after intent");
  }
  const rootPanel = reconcileNode(view.root, tabsById);
  const activePanelId = focusTabId
    ? (findLeafByTab(rootPanel, focusTabId)?.id ?? view.activePanelId)
    : view.activePanelId;
  return { rootPanel, activePanelId };
}

/** Map a {@link DropEdge} to a `layout.moveTab` payload for a split-with-tab drop. */
export function moveTabPayload(
  tabId: string,
  targetPanelId: string,
  edge: DropEdge
): Record<string, unknown> {
  return { tabId, targetPanelId, edge };
}

/** Log a bridge fallback so the local-path recovery is visible in the LogViewer. */
export function logBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("layout_bridge", `${kind} fell back to local mutation: ${message}`);
}

// ── Render-from-projection (step 3): compose structure ⊕ content, gate, seed ──
//
// Step 2 made `LayoutStore` authoritative for structural mutations and mirrored
// the reconciled tree back into `appStore.rootPanel`. Step 3 cuts the renderer
// itself over: `SplitView` sources its panel/tab **structure** from the
// projected `layout@<clientId>` render-list and overlays per-tab **content**
// (title, colour, session status, broadcast, zoom) from `appStore` — the
// partial-projection seam (Decision #2). The composition reuses the tested
// {@link reconcileNode}: the projection supplies the tree shape (leaf/split
// nodes, tab order, active tab, split sizes, panel ids); `appStore`'s current
// rich tabs supply the content, re-attached by id. Because the composed tree
// carries the same `tab.id`/`panel.id`s, the live xterm DOM (registered by tab
// id, adopted by the id-keyed `TerminalSlot`) is reparented, never remounted.
//
// **Strangler safety.** The renderer only composes from the projection when the
// projected view is a *faithful structural mirror* of `appStore`'s tree
// ({@link viewMatchesTree}); otherwise it falls back to `appStore.rootPanel`
// verbatim. Tab create/close/reorder/activate are not yet layout intents
// (deferred), so those edit `appStore` locally and momentarily desync the
// region — the gate makes the renderer fall back rather than show a stale tree,
// and {@link seedLayoutRegion} catches the region back up so composing resumes.
// The gate guarantees the composed tree is structurally identical to
// `appStore.rootPanel`, so rendering can never diverge from the pre-cut output.

/** Deep structural equality over two minimal projected trees (order-independent
 * on object keys; array order is significant, as it is user-visible tab/panel
 * order). */
export function minimalNodesEqual(a: MinimalNode, b: MinimalNode): boolean {
  if (a.type !== b.type) return false;
  if (a.id !== b.id) return false;
  if (a.type === "leaf" && b.type === "leaf") {
    if (a.activeTabId !== b.activeTabId) return false;
    if (a.tabs.length !== b.tabs.length) return false;
    return a.tabs.every((t, i) => {
      const o = b.tabs[i];
      return (
        t.id === o.id &&
        (t.sessionId ?? null) === (o.sessionId ?? null) &&
        t.contentType === o.contentType
      );
    });
  }
  if (a.type === "split" && b.type === "split") {
    if (a.direction !== b.direction) return false;
    if ((a.lastActiveLeafId ?? null) !== (b.lastActiveLeafId ?? null)) return false;
    if (!sizesEqual(a.sizes, b.sizes)) return false;
    if (a.children.length !== b.children.length) return false;
    return a.children.every((c, i) => minimalNodesEqual(c, b.children[i]));
  }
  return false;
}

/** Compare two optional split-size arrays exactly. */
function sizesEqual(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

/**
 * Whether a projected `view` is a faithful structural mirror of `root` +
 * `activePanelId` — the gate that decides if the renderer may source structure
 * from the projection (true) or must fall back to `appStore` (false).
 */
export function viewMatchesTree(
  view: LayoutView | null | undefined,
  root: PanelNode,
  activePanelId: string | null
): boolean {
  if (!view || !view.root) return false;
  if ((view.activePanelId ?? null) !== (activePanelId ?? null)) return false;
  return minimalNodesEqual(toMinimalNode(root), view.root);
}

/**
 * Compose the rich render tree from a projected view: **structure** from
 * `view.root`, **content** re-attached by tab id — preferring the flat
 * `contentById` {@link TabContent} map (part of #2283), and falling back to
 * `contentRoot`'s in-tree rich tabs for any id the map does not yet hold. Throws
 * (via {@link reconcileNode}) if the view references a tab absent from **both**;
 * callers gate with {@link viewMatchesTree} first so this never throws on the
 * happy path.
 */
export function composeRenderTree(
  view: LayoutView,
  contentRoot: PanelNode,
  contentById?: Record<string, TabContent>
): PanelNode {
  return reconcileNode(view.root, collectTabs(contentRoot), contentById);
}

/** Ensure the layout region client is subscribed; the renderer's entry point.
 * `async` so a synchronous transport-construction failure (e.g. non-Tauri, no
 * socket) surfaces as a rejection the caller can catch and fall back on. */
export async function ensureLayoutRegionClient(): Promise<ProjectionClient> {
  return ensureSubscribed();
}

/**
 * Seed the layout region with a whole tree so the projection tracks
 * `appStore`'s current structure (the render-side counterpart to the mutation
 * bridge's seed-before-mutate). Idempotent server-side: replacing with the same
 * tree yields no diff.
 */
export async function seedLayoutRegion(
  root: PanelNode,
  activePanelId: string | null
): Promise<void> {
  throwIfRejected(
    await dispatch("layout.replace", { root: toMinimalNode(root), activePanelId }),
    "replace"
  );
}

/** Log a render-path fallback so the projection-cut recovery is visible. */
export function logRenderFallback(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("layout_bridge", `render fell back to appStore tree: ${message}`);
}
