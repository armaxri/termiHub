/**
 * Layout projection bridge — the region-authoritative layout data flow
 * (#2151 / #2283 / #2562, part of #2139).
 *
 * The backend `LayoutStore` serves the client-scoped `layout@<clientId>`
 * projection region and is authoritative for **panel-tree structure**. `appStore`
 * no longer stores `rootPanel`/`tabGroups`/`activePanelId`/`activeTabGroupId`; it
 * keeps only the raw region `layoutView` plus the frontend-only directional
 * {@link LayoutSplitMarks} (#448), and every structural read composes a rich tree
 * on demand through {@link composeLayoutFromView} (its sole derivation seam).
 *
 * # Writers
 *
 * The region→appStore mirror ({@link subscribeLayoutRegion}) is the **sole
 * writer** of `appStore`'s `layoutView`: it recomposes on every region change.
 * Two kinds of write feed the region:
 *
 * - **Granular structural mutations** (split / move-tab / merge-a-tab /
 *   split-with-tab) dispatch `layout.*` intents optimistically via
 *   {@link mirrorLayoutIntent} / {@link mirrorLayoutMove}.
 * - The **~15 non-intent structural writers** (tab openers, cross-window handoff,
 *   workspace restore, the agent-error→terminal conversion, directional marking)
 *   have no granular intent, so they keep their local `appStore` write and then
 *   {@link reseedLayoutRegion} the whole layout to keep the region a faithful
 *   mirror.
 *
 * # Rich ⇄ minimal
 *
 * The region carries only structure + the minimal tab model
 * (`{ id, sessionId, contentType }`); each tab's rich content is re-attached by
 * id from `appStore.tabContent` via {@link reconcileNode} (the xterm DOM is
 * registered globally by tab id, so a moved tab keeps its live session +
 * scrollback).
 *
 * # Resilience
 *
 * Every write path is best-effort: a missing transport (non-Tauri without a
 * socket) or a rejected dispatch is logged ({@link logBridgeFallback}) and never
 * throws — the local `appStore` write already landed, and the next reseed
 * re-syncs the region.
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
 * `contentById` is optional so a caller with no content map can reconstruct
 * straight from the tree.
 *
 * Throws if the projection references a tab absent from **both** sources; the
 * caller ({@link composeLayoutFromView}) catches it and keeps its last-good tree.
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
 * Optimistically mirror a granular layout mutation into the client's
 * `layout@<clientId>` region (#2283 slice D', the un-gated timing win).
 *
 * `preSnapshot`/`postSnapshot` are the pre- and post-transform layouts the caller
 * computed with the shared panel-tree algebra. This function pushes the
 * transition into the projection region **without** a `seed→await→reconcile`
 * round-trip:
 *
 * - it overlays `postSnapshot` — the already-transformed tree, with ids that
 *   match what the granular intent will produce — onto the region
 *   **synchronously** via {@link ProjectionClient.dispatchOptimistic}, so the
 *   render path reflects the mutation at once (no flicker while the backend
 *   round-trip lands);
 * - it seeds the backend to `preSnapshot` (fire-and-forget; the transport
 *   preserves order) so the authoritative store applies the granular `kind`
 *   intent to the correct pre-transform tree and converges to the same view,
 *   at which point the optimistic overlay is pruned.
 *
 * Never throws (resilience): a transport-construction failure (non-Tauri without
 * a socket) or a rejected/failed dispatch is caught and logged; the next
 * {@link reseedLayoutRegion} re-syncs the region — nothing is lost. A rejected
 * optimistic dispatch rolls its overlay back at
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
    // No transport (e.g. non-Tauri without a socket): a failed mirror is a
    // resilience event, not a crash — the next reseed re-syncs the region.
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

/**
 * Mirror a **panel-geometry-changing move** (a cross-panel tab move or a
 * cross-group tab move) into the region as a single atomic commit of the
 * *settled* tree (#2712).
 *
 * A move detaches a tab and prunes its now-empty source leaf, so the pre-move
 * (`preSnapshot`) and settled (`postSnapshot`) trees differ in panel **count** —
 * and therefore in panel **width**. The generic {@link mirrorLayoutIntent} path
 * seeds the backend to `preSnapshot` and then applies the granular intent, which
 * makes the authoritative region emit **two** frames: the pre-prune tree, then
 * the settled tree. The optimistic overlay is meant to mask the first, but the
 * masking is version-gated, and on macOS/WKWebView the intermediate pre-prune
 * frame is exposed for ~300 ms. That transient reflows the terminal's xterm to
 * the narrow (~40-col) two-panel width and back; the shell's SIGWINCH prompt
 * redraw at the narrow width overwrites and destroys the scrollback
 * (`test_cross_panel_move_preserves_scrollback`). ubuntu/Windows coalesce the
 * two frames so the transient stays latent, but it is the same #2283
 * optimistic→authoritative round-trip that produced #2705's stale-id facet.
 *
 * Installing the settled tree in a **single** `layout.replaceGroups` commit under
 * the optimistic overlay means the region only ever holds the final tree: the
 * optimistic and authoritative views are structurally identical, so no
 * intermediate two-panel snapshot — and thus no interim narrow width — is ever
 * produced, on any platform. The whole-layout replace is exact: the backend
 * `replace_groups` stores the tree verbatim (`src-tauri/src/layout/store.rs`),
 * and `appStore` already computed `postSnapshot` with the shared panel-tree
 * algebra, so the region converges to the very tree the granular move would have
 * yielded — without the pre-prune step.
 *
 * Never throws (resilience): delegates to {@link reseedLayoutRegion}, which
 * catches a missing transport or a rejected dispatch and logs it while
 * `appStore` stays authoritative.
 */
export function mirrorLayoutMove(preSnapshot: LayoutSnapshot, postSnapshot: LayoutSnapshot): void {
  // No-op guard (parity with mirrorLayoutIntent): a move that changed nothing —
  // dropping a tab onto its own panel, or onto the active group — leaves the tree
  // structurally identical, so there is nothing to commit.
  if (layoutSnapshotsEqual(preSnapshot, postSnapshot)) return;
  reseedLayoutRegion(postSnapshot);
}

/** Map a {@link DropEdge} to a `layout.moveTab` payload for a split-with-tab drop. */
export function moveTabPayload(
  tabId: string,
  targetPanelId: string,
  edge: DropEdge
): Record<string, unknown> {
  return { tabId, targetPanelId, edge };
}

/** Log a layout-region write failure so the resilience recovery is visible in the LogViewer. */
export function logBridgeFallback(kind: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("layout_bridge", `${kind} region write failed: ${message}`);
}

// ── Compose structure ⊕ content: region view → rich render tree ───────────────
//
// The region is authoritative for panel/tab **structure**; `SplitView` renders a
// rich tree composed on demand by {@link composeLayoutFromView}. The projected
// `layout@<clientId>` view supplies the tree shape (leaf/split nodes, tab order,
// active tab, split sizes, panel ids); each tab's per-tab **content** (title,
// colour, session status, broadcast, zoom) is re-attached by id from
// `appStore.tabContent` via {@link reconcileNode}. Because the composed tree
// carries the same `tab.id`/`panel.id`s, the live xterm DOM (registered by tab
// id, adopted by the id-keyed `TerminalSlot`) is reparented, never remounted.
//
// A view tab absent from `tabContent` is a transient desync (e.g. the initial
// backend-default snapshot before the region is seeded from `appStore`);
// {@link composeLayoutFromView} catches it and returns `null` so the caller keeps
// its last-good tree until the next reseed catches the region up.

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
 * Directional split-nav marks (#448), relocated out of the layout trees into a
 * dedicated field on `appStore` (#2562). `groupId → splitId → lastActiveLeafId`.
 * The backend region does not carry these (they are a frontend-only derivation of
 * `set_active_panel`), so with the mirror-fields gone the marks must live
 * somewhere the compose can re-apply them from — this map. `appStore`'s `#448`
 * subscription is its sole writer; {@link composeLayoutFromView} its sole reader.
 */
export type LayoutSplitMarks = Record<string, Record<string, string>>;

/** The `layout@<clientId>` view for a rich {@link LayoutSnapshot} (seed / reseed). */
export function viewFromSnapshot(snapshot: LayoutSnapshot): LayoutView {
  return {
    groups: snapshot.groups.map(toMinimalGroup),
    activeGroupId: snapshot.activeGroupId,
  };
}

/** A single tree's directional split marks by split-container id (#448 / #2562). */
export function splitMarksOfTree(root: PanelNode): Record<string, string> {
  const m = new Map<string, string>();
  collectSplitMarks(root, m);
  return Object.fromEntries(m);
}

/** Index every group's directional split marks by group id, then split id. */
export function extractSplitMarks(snapshot: LayoutSnapshot): LayoutSplitMarks {
  const out: LayoutSplitMarks = {};
  for (const g of snapshot.groups) {
    const m = new Map<string, string>();
    collectSplitMarks(g.root, m);
    if (m.size > 0) out[g.id] = Object.fromEntries(m);
  }
  return out;
}

/** Apply a group's directional-mark record onto a freshly composed tree by split id. */
function applyMarksRecord(node: PanelNode, marks: Record<string, string> | undefined): PanelNode {
  if (!marks || node.type !== "split") return node;
  const map = new Map(Object.entries(marks));
  return preserveSplitMarks(node, map);
}

/**
 * Compose the full `appStore` layout ({@link ComposedLayoutState}) from a raw
 * region {@link LayoutView}, the by-id `tabContent` map, and the relocated
 * directional {@link LayoutSplitMarks} (#2562). This is the sole layout-derivation
 * seam once the four mirror fields are gone: `appStore` stores only the raw
 * `layoutView` + `layoutSplitMarks`, and every structural read (reducers,
 * selectors, snapshots) composes through here.
 *
 * It derives **every** group — including the active one — uniformly from the
 * view, and sources directional marks from `marks`. Content is
 * sourced **solely** from `tabContent` (#2566); a view tab absent from it throws
 * (caught → `null`, a transient desync the caller treats as "keep last good").
 * The active group's `rootPanel`/`activePanelId` are the same objects as its
 * `tabGroups` entry, so structural reads and per-group reads never diverge.
 */
export function composeLayoutFromView(
  view: LayoutView | null | undefined,
  tabContent: Record<string, TabContent>,
  marks: LayoutSplitMarks
): ComposedLayoutState | null {
  if (!view || !Array.isArray(view.groups) || view.groups.length === 0) return null;
  try {
    const activeGroupId = view.activeGroupId;
    const activeView = activeGroupOf(view);
    if (!activeView) return null;
    const tabGroups: TabGroup[] = view.groups.map((vg) => {
      const entry: TabGroup = {
        id: vg.id,
        name: vg.name,
        rootPanel: applyMarksRecord(
          reconcileNode(vg.root, EMPTY_TREE_FALLBACK, tabContent),
          marks[vg.id]
        ),
        activePanelId: vg.activePanelId,
      };
      if (vg.color != null) entry.color = vg.color;
      return entry;
    });
    const activeEntry = tabGroups.find((g) => g.id === activeGroupId) ?? tabGroups[0];
    return {
      rootPanel: activeEntry.rootPanel,
      activePanelId: activeEntry.activePanelId,
      tabGroups,
      activeTabGroupId: activeGroupId,
    };
  } catch (err) {
    logRenderFallback(err);
    return null;
  }
}

/** Shared empty content-fallback for {@link composeLayoutFromView}: content comes
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

/** Log a compose failure (a transient region↔content desync) so recovery is visible. */
export function logRenderFallback(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  frontendLog("layout_bridge", `compose skipped, kept last-good tree: ${message}`);
}
