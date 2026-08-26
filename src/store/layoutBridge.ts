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
  InMemoryTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type Intent,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type {
  DropEdge,
  LeafPanel,
  PanelNode,
  SplitContainer,
  TabContent,
  TabGroup,
  TerminalTab,
} from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";

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

/**
 * One projected tab group (twin of the Rust `GroupLayout`): its panel tree plus
 * metadata and focused panel. `color` is omitted when unset.
 */
export interface MinimalGroup {
  id: string;
  name: string;
  color?: string;
  root: MinimalNode;
  activePanelId: string | null;
}

/**
 * The `layout@<clientId>` region view model — the full multi-group view emitted
 * by `LayoutStore::snapshot_full()` (#2283 slice C): every tab group plus the
 * active group id. The renderer composes the **active** group; the rest are
 * carried so the region is a faithful mirror of `appStore`'s groups.
 */
export interface LayoutView {
  groups: MinimalGroup[];
  activeGroupId: string;
}

/**
 * One tab group in the rich `appStore`-side snapshot: the authoritative panel
 * tree (rich {@link PanelNode}) plus metadata and focused panel. Built by
 * {@link buildLayoutSnapshot} from `appStore.tabGroups` with the active group's
 * live tree overlaid.
 */
export interface GroupSnapshot {
  id: string;
  name: string;
  color?: string;
  root: PanelNode;
  activePanelId: string | null;
}

/** The rich `appStore`-side multi-group snapshot: the seed/gate input. */
export interface LayoutSnapshot {
  groups: GroupSnapshot[];
  activeGroupId: string;
}

/**
 * Build the rich {@link LayoutSnapshot} from `appStore`'s group state. Only the
 * **active** group's live tree lives at the top-level `rootPanel`/`activePanelId`
 * (the matching `tabGroups` entry is stale until a switch), so the active group
 * is overlaid from those while the rest come from their `tabGroups` entries.
 */
export function buildLayoutSnapshot(
  tabGroups: TabGroup[],
  activeGroupId: string,
  activeRoot: PanelNode,
  activeRootActivePanelId: string | null
): LayoutSnapshot {
  return {
    groups: tabGroups.map((g) => {
      const isActive = g.id === activeGroupId;
      const snap: GroupSnapshot = {
        id: g.id,
        name: g.name,
        root: isActive ? activeRoot : g.rootPanel,
        activePanelId: isActive ? activeRootActivePanelId : g.activePanelId,
      };
      if (g.color != null) snap.color = g.color;
      return snap;
    }),
    activeGroupId,
  };
}

/** Project a rich {@link GroupSnapshot} to its minimal wire form (for seeding). */
export function toMinimalGroup(group: GroupSnapshot): MinimalGroup {
  const minimal: MinimalGroup = {
    id: group.id,
    name: group.name,
    root: toMinimalNode(group.root),
    activePanelId: group.activePanelId,
  };
  if (group.color != null) minimal.color = group.color;
  return minimal;
}

/** The active group of a projected view (falls back to the first group). */
export function activeGroupOf(view: LayoutView): MinimalGroup | undefined {
  return view.groups.find((g) => g.id === view.activeGroupId) ?? view.groups[0];
}

// ── Transport + region client (sync-create, mirrors the file-browsers slice) ───

// A stable per-session client identity. The client-scoped region is
// `layout@<clientId>`, and dispatched intents carry the same id, so this
// checkout mutates and subscribes to its own layout region.
const clientId = newClientId();
const region = `layout@${clientId}`;

let transportInstance: Transport | null = null;
/** The region client once its subscription has started (its snapshot adopted). */
let regionClient: ProjectionClient | null = null;
/** The region client the moment it is created — before `start()` resolves — so an
 * optimistic dispatch can overlay on it synchronously ({@link mirrorLayoutIntent}).
 * Same object as {@link regionClient} once started. */
let creatingClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;

/**
 * Registered region→appStore mirror handlers (#2283 slice E2). Kept in a set so
 * they are **re-attached** whenever the client is (re)created — a transport swap
 * ({@link setLayoutTransportForTest}) or {@link stopLayoutSubscription} drops the
 * old client and its listeners, and with the local reducers gone the mirror is
 * the *sole* writer of `appStore`'s layout, so it must not be orphaned by a reset.
 */
const layoutMirrorHandlers = new Set<(view: LayoutView | undefined) => void>();

/** Attach every registered mirror handler's `onChange` to a freshly-made client. */
function attachLayoutMirrorHandlers(client: ProjectionClient): void {
  for (const handler of layoutMirrorHandlers) {
    client.onChange((state) => handler(state.view as LayoutView | undefined));
  }
}

/** Inject a transport for tests; `null` restores the lazily-created real one and
 * drops any active subscription. Registered mirror handlers survive and re-attach
 * to the next client. */
export function setLayoutTransportForTest(t: Transport | null): void {
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
  transportInstance = t;
}

function transport(): Transport {
  if (!transportInstance) {
    // The region→appStore mirror (#2283 slice E1) needs a *constructable* transport
    // in every environment so the client's synchronous optimistic overlay can drive
    // it. `createTransport()` throws in a non-Tauri environment with no remote-client
    // socket (headless unit tests; remote-client mode before its socket lands,
    // #2166); fall back to a backend-less {@link InMemoryTransport} there so layout
    // stays a working, region-derived projection rather than silently colliding.
    try {
      transportInstance = createTransport();
    } catch {
      transportInstance = new InMemoryTransport();
    }
  }
  return transportInstance;
}

/**
 * The region client instance, created **synchronously** on first use — before its
 * subscription has started — so an optimistic dispatch can overlay on it at once
 * (mirrors `fileBrowsersRegionClient`). Returns the started {@link regionClient}
 * once available, else the {@link creatingClient}. Throws only if the transport
 * itself cannot be built (non-Tauri without a socket).
 */
function layoutRegionClient(): ProjectionClient {
  if (regionClient) return regionClient;
  if (!creatingClient) {
    creatingClient = new ProjectionClient(transport(), region);
    // Re-bind the region→appStore mirror to the new client (E2): a transport swap
    // or subscription reset drops the previous client and its listeners.
    attachLayoutMirrorHandlers(creatingClient);
  }
  return creatingClient;
}

/**
 * Ensure the `layout@<clientId>` region client is subscribed, so intent diffs
 * are received. Idempotent and de-duplicated across concurrent callers.
 */
function ensureSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = layoutRegionClient();
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

/** Drop the region subscription (tests / re-init). */
export function stopLayoutSubscription(): void {
  (regionClient ?? creatingClient)?.stop();
  regionClient = null;
  creatingClient = null;
  startPromise = null;
}

/**
 * The layout region's current effective (optimistically-overlaid) view — for
 * synchronous test assertions on the projection. `undefined` before the client
 * exists / its first snapshot.
 */
export function currentLayoutView(): LayoutView | undefined {
  return (regionClient ?? creatingClient)?.state.view as LayoutView | undefined;
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

// ── Optimistic mirror: synchronous fold overlay + granular intent dispatch ─────

/**
 * Optimistically mirror a layout mutation into the client's `layout@<clientId>`
 * region (#2283 slice D', the un-gated timing win).
 *
 * The `appStore` reducer has **already** applied the mutation to its
 * authoritative `rootPanel`/`tabGroups` — the retained instant-revert path that
 * this slice deliberately keeps (the #2283 fallback removal stays gated). This
 * function pushes the same transition into the projection region **without** the
 * old `seed→await→reconcile` round-trip:
 *
 * - it overlays `postSnapshot` — `appStore`'s already-transformed tree, so the
 *   region matches `appStore`'s ids exactly — onto the region **synchronously**
 *   via {@link ProjectionClient.dispatchOptimistic}, so the render path reflects
 *   the mutation at once (no fallback flicker while a backend round-trip lands);
 * - it seeds the backend to `preSnapshot` (fire-and-forget; the transport
 *   preserves order) so the authoritative store applies the granular `kind`
 *   intent to the correct pre-transform tree and converges to the same view,
 *   at which point the optimistic overlay is pruned.
 *
 * Never throws (resilience): a transport-construction failure (non-Tauri without
 * a socket) or a rejected/failed dispatch is caught and logged. `appStore`
 * stays authoritative, so the render path's faithful-mirror gate simply keeps
 * rendering `appStore.rootPanel` and {@link seedLayoutRegion} re-syncs the region
 * — nothing is lost. A rejected optimistic dispatch rolls its overlay back at
 * once ({@link ProjectionClient.dispatchOptimistic}), leaving the region on the
 * backend's view while `appStore` holds the local result.
 */
export function mirrorLayoutIntent(
  kind: string,
  payload: Record<string, unknown>,
  preSnapshot: LayoutSnapshot,
  postSnapshot: LayoutSnapshot
): void {
  // No-op guard (#2283 slice E1): a reducer that made no structural change — a
  // defensive no-op such as dragging a tab onto its own group, or moving a tab
  // that does not exist — leaves `pre` structurally equal to `post`. Skip the
  // dispatch so the region→appStore mirror does not fire and needlessly re-derive
  // an identical tree, which would churn object identity and re-render. There is
  // nothing to sync: the region view is purely structural.
  if (layoutSnapshotsEqual(preSnapshot, postSnapshot)) return;

  let client: ProjectionClient;
  try {
    client = layoutRegionClient();
  } catch (err) {
    // No transport (e.g. non-Tauri without a socket): appStore already holds the
    // authoritative result, so a failed mirror is a resilience event, not a crash.
    logBridgeFallback(kind, err);
    return;
  }

  // Ensure the region is subscribed so the authoritative diff arrives to prune the
  // overlay; a subscribe failure is logged and does not strand it.
  void ensureSubscribed().catch((err) => logBridgeFallback("subscribe", err));

  const postView: LayoutView = {
    groups: postSnapshot.groups.map(toMinimalGroup),
    activeGroupId: postSnapshot.activeGroupId,
  };

  // Seed the authoritative backend to the pre-transform layout so the granular
  // intent it then applies produces the same tree (fire-and-forget, ordered
  // before the intent by the transport's FIFO delivery).
  void dispatch("layout.replaceGroups", {
    groups: preSnapshot.groups.map(toMinimalGroup),
    activeGroupId: preSnapshot.activeGroupId,
  })
    .then((ack) => throwIfRejected(ack, "replaceGroups"))
    .catch((err) => logBridgeFallback("replaceGroups", err));

  // Dispatch the granular intent under a synchronous optimistic overlay that
  // installs `postView` at once. The overlay is a last-writer constant (it
  // ignores the baseline), so the region reflects the mutation even before the
  // seed diff lands, and is pruned when the intent's version confirms.
  const intent: Intent = { intentId: newIntentId(), kind, payload, clientId };
  void client
    .dispatchOptimistic(intent, () => postView)
    .then((ack) => {
      if (ack.status === "rejected") {
        logBridgeFallback(kind, new Error(ack.error?.message ?? "rejected"));
      }
    })
    .catch((err) => logBridgeFallback(kind, err));
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
 * Compose the rich render tree for the **active** group of a projected view:
 * **structure** from the active group's `root`, **content** re-attached by tab
 * id — preferring the flat `contentById` {@link TabContent} map (part of #2283),
 * and falling back to `activeContentRoot`'s in-tree rich tabs for any id the map
 * does not yet hold. `activeContentRoot` is `appStore`'s active-group rich tree
 * (its `rootPanel`). Throws (via {@link reconcileNode}) if the view references a
 * tab absent from **both**; callers gate with {@link viewMatchesTree} first so
 * this never throws on the happy path.
 */
export function composeRenderTree(
  view: LayoutView,
  activeContentRoot: PanelNode,
  contentById?: Record<string, TabContent>
): PanelNode {
  const group = activeGroupOf(view);
  if (!group) {
    throw new Error("layout view has no active group");
  }
  return reconcileNode(group.root, collectTabs(activeContentRoot), contentById);
}

/** Ensure the layout region client is subscribed; the renderer's entry point.
 * `async` so a synchronous transport-construction failure (e.g. non-Tauri, no
 * socket) surfaces as a rejection the caller can catch and fall back on. */
export async function ensureLayoutRegionClient(): Promise<ProjectionClient> {
  return ensureSubscribed();
}

/** The `appStore` layout fields a region view composes into (the mirror's output). */
export interface ComposedLayoutState {
  rootPanel: PanelNode;
  activePanelId: string | null;
  tabGroups: TabGroup[];
  activeTabGroupId: string;
}

/**
 * Compose `appStore`'s layout fields from a projected {@link LayoutView} — the
 * inverse of {@link buildLayoutSnapshot}, and the core of the region→appStore
 * mirror (#2283 slice E1). Structure comes from the view; each tab's rich content
 * is re-attached by id via {@link reconcileNode} from the flat `tabContent` map
 * **alone** (#2566) — `appStore` keeps that map complete and current for every
 * `TabContentType`, so composition never falls back to the current
 * `curRootPanel`/`curTabGroups` rich trees for content. Those trees are still
 * consulted, but only for **structure** the region view does not carry: the
 * directional `lastActiveLeafId` marks and the active group's verbatim entry.
 * Returns:
 *
 * - top-level `rootPanel`/`activePanelId` composed from the **active** group's
 *   live tree,
 * - `activeTabGroupId` from the view, and
 * - `tabGroups`: **non-active** groups composed from the view; the **active**
 *   group's entry kept verbatim from `curTabGroups` (`{ ...cur }`). This mirrors
 *   `appStore`'s convention exactly — the active group's live tree lives at the
 *   top level, so its `tabGroups` entry is intentionally left as the last-saved
 *   (possibly stale) tree until a group switch re-saves it. Keeping it verbatim
 *   makes the composed state byte-identical to the local reducers' result.
 *
 * Returns `null` (mirror skips, leaving `appStore` untouched) when the view is
 * empty/absent, or when it references a tab absent from `tabContent` (a transient
 * desync — e.g. the initial backend-default snapshot before the region is seeded
 * from `appStore`). Callers gate with {@link viewMatchesTree} first, so on the
 * happy path this composes cleanly.
 */
/** Shared empty content-fallback for {@link composeLayoutState}: content now comes
 * solely from `tabContent`, so `reconcileNode` is handed no tree fallback (#2566).
 * Shared/reused — `reconcileNode` only reads (never mutates) its `tabsById` arg. */
const EMPTY_TREE_FALLBACK: Map<string, TerminalTab> = new Map();
/** Index a tree's directional `lastActiveLeafId` marks by split-container id. */
function collectSplitMarks(node: PanelNode, into: Map<string, string>): void {
  if (node.type === "split") {
    if (node.lastActiveLeafId) into.set(node.id, node.lastActiveLeafId);
    node.children.forEach((c) => collectSplitMarks(c, into));
  }
}

/**
 * Re-apply directional `lastActiveLeafId` marks (#448) from `prior` onto a freshly
 * composed tree, by split-container id. The marks are a **frontend-only** derivation
 * (the backend `set_active_panel` does not mark), so the region does not carry them;
 * without this the region→appStore mirror would drop a split's last-focused-child
 * memory every time it recomposes. A split absent from `prior` keeps whatever mark
 * the composed tree already has.
 */
function preserveSplitMarks(node: PanelNode, marks: Map<string, string>): PanelNode {
  if (node.type !== "split") return node;
  const children = node.children.map((c) => preserveSplitMarks(c, marks));
  const next: SplitContainer = { ...node, children };
  const mark = marks.get(node.id);
  if (mark !== undefined) next.lastActiveLeafId = mark;
  return next;
}

export function composeLayoutState(
  view: LayoutView | null | undefined,
  curRootPanel: PanelNode,
  curTabGroups: TabGroup[],
  tabContent: Record<string, TabContent>
): ComposedLayoutState | null {
  if (!view || !Array.isArray(view.groups) || view.groups.length === 0) return null;

  // Content is sourced **solely** from `tabContent` (#2566): every tab-creation
  // and content-mutation reducer in `appStore` keeps this by-id map complete and
  // current for every `TabContentType`, so composition never consults the current
  // `curRootPanel`/`curTabGroups` rich trees for content. Those trees are still
  // read below, but only for **structure** the region view does not carry —
  // directional `lastActiveLeafId` marks and the active group's verbatim entry.
  // An empty content-fallback map is passed to `reconcileNode` so a view id absent
  // from `tabContent` throws (caught below → `null`) rather than silently resolving
  // from a possibly-stale tree; that is the retained transient-desync guard.
  const noTreeFallback: Map<string, TerminalTab> = EMPTY_TREE_FALLBACK;

  // Directional marks by group id, from the prior `appStore` trees (active group's
  // live tree overriding its stale `tabGroups` entry) — re-applied onto each
  // freshly composed tree so the mirror never drops a split's last-focused memory.
  const marksByGroup = new Map<string, Map<string, string>>();
  for (const g of curTabGroups) {
    const m = new Map<string, string>();
    collectSplitMarks(g.id === view.activeGroupId ? curRootPanel : g.rootPanel, m);
    marksByGroup.set(g.id, m);
  }

  try {
    const activeGroupId = view.activeGroupId;
    const activeView = activeGroupOf(view);
    if (!activeView) return null;

    const tabGroups: TabGroup[] = view.groups.map((vg) => {
      if (vg.id === activeGroupId) {
        const cur = curTabGroups.find((g) => g.id === vg.id);
        // Keep the active group's `appStore` entry's tree/activePanelId (the live
        // tree is the top-level `rootPanel`, so this entry is intentionally stale),
        // but track its metadata (name/color) from the region view — a rename or
        // recolor of the active group changes only that.
        if (cur) {
          const entry: TabGroup = { ...cur, name: vg.name };
          if (vg.color != null) entry.color = vg.color;
          else delete entry.color;
          return entry;
        }
      }
      const entry: TabGroup = {
        id: vg.id,
        name: vg.name,
        rootPanel: preserveSplitMarks(
          reconcileNode(vg.root, noTreeFallback, tabContent),
          marksByGroup.get(vg.id) ?? new Map()
        ),
        activePanelId: vg.activePanelId,
      };
      if (vg.color != null) entry.color = vg.color;
      return entry;
    });

    return {
      rootPanel: preserveSplitMarks(
        reconcileNode(activeView.root, noTreeFallback, tabContent),
        marksByGroup.get(activeGroupId) ?? new Map()
      ),
      activePanelId: activeView.activePanelId,
      tabGroups,
      activeTabGroupId: activeGroupId,
    };
  } catch (err) {
    // A tab referenced by the view but absent from both sources: treat as a
    // transient desync and leave `appStore` on its current tree.
    logRenderFallback(err);
    return null;
  }
}

/**
 * Register the region→appStore layout mirror (#2283 slice E1). `handler` is
 * invoked with the region's current view on every change — synchronously on this
 * client's own optimistic dispatch (so the mirror lands within the reducer call),
 * and again when the authoritative diff/snapshot arrives. Subscribes the region
 * (idempotent) so the stream is live. Returns an unsubscribe.
 */
export function subscribeLayoutRegion(handler: (view: LayoutView | undefined) => void): () => void {
  const alreadyRegistered = layoutMirrorHandlers.has(handler);
  layoutMirrorHandlers.add(handler);
  // Attach to the current client now. If the client did not yet exist,
  // `layoutRegionClient()` creates it and `attachLayoutMirrorHandlers` binds every
  // registered handler (including this one) — so only bind here when the client was
  // already live and would not have picked this handler up on creation.
  const hadClient = regionClient !== null || creatingClient !== null;
  const client = layoutRegionClient();
  let off = (): void => {};
  if (hadClient && !alreadyRegistered) {
    off = client.onChange((state) => handler(state.view as LayoutView | undefined));
  }
  void ensureSubscribed().catch((err) => logRenderFallback(err));
  return () => {
    layoutMirrorHandlers.delete(handler);
    off();
  };
}

/**
 * Reseed the layout region to `snapshot` **synchronously and optimistically**
 * (#2283 slice E2). Installs `snapshot`'s view as the region's effective view at
 * once via {@link ProjectionClient.dispatchOptimistic} — so the region→appStore
 * mirror composes it immediately — and replaces the backend's layout via
 * `layout.replaceGroups` so the authoritative store converges to the same view.
 *
 * This is the retained reseed-safety, relocated from the render-side gate to the
 * write sites: the region has no granular intent for the ~15 **non-intent**
 * structural writers (the tab openers, cross-window handoff, workspace restore,
 * the agent-error→terminal conversion) or for the directional `lastActiveLeafId`
 * marking, so each keeps its local `appStore` write and reseeds the region after,
 * keeping the region a faithful mirror rather than letting it lag (which, with the
 * unconditional mirror, would strand the just-written tab on the next diff).
 *
 * Never throws (resilience): a missing transport or a rejected dispatch is logged;
 * `appStore` keeps its local write, and the next reseed re-syncs the region.
 */
export function reseedLayoutRegion(snapshot: LayoutSnapshot): void {
  const view: LayoutView = {
    groups: snapshot.groups.map(toMinimalGroup),
    activeGroupId: snapshot.activeGroupId,
  };
  try {
    const client = layoutRegionClient();
    void ensureSubscribed().catch((err) => logBridgeFallback("subscribe", err));
    const intent: Intent = {
      intentId: newIntentId(),
      kind: "layout.replaceGroups",
      payload: { groups: view.groups, activeGroupId: view.activeGroupId },
      clientId,
    };
    void client
      .dispatchOptimistic(intent, () => view)
      .then((ack) => {
        if (ack.status === "rejected") {
          logBridgeFallback("reseed", new Error(ack.error?.message ?? "rejected"));
        }
      })
      .catch((err) => logBridgeFallback("reseed", err));
  } catch (err) {
    // No transport, or an incomplete client (e.g. a partial test stub): the local
    // `appStore` write already landed, and the next reseed re-syncs the region.
    logBridgeFallback("reseed", err);
  }
}

/** Structural equality over two rich {@link LayoutSnapshot}s — used to de-dupe
 * reseeds (a settled layout is not reseeded on every render). */
export function layoutSnapshotsEqual(a: LayoutSnapshot, b: LayoutSnapshot): boolean {
  if ((a.activeGroupId ?? null) !== (b.activeGroupId ?? null)) return false;
  if (a.groups.length !== b.groups.length) return false;
  return a.groups.every((g, i) => {
    const o = b.groups[i];
    return (
      g.id === o.id &&
      g.name === o.name &&
      (g.color ?? null) === (o.color ?? null) &&
      (g.activePanelId ?? null) === (o.activePanelId ?? null) &&
      minimalNodesEqual(toMinimalNode(g.root), toMinimalNode(o.root))
    );
  });
}

/** Log a render-path fallback so the projection-cut recovery is visible. */
export function logRenderFallback(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("layout_bridge", `render fell back to appStore tree: ${message}`);
}
