/**
 * Layout projection bridge — Phase 3 step 2 of the stateless-UI migration
 * (#2151, part of #2139).
 *
 * Step 1 landed a shadow, backend-authoritative `LayoutStore` served as the
 * client-scoped `layout@<clientId>` projection region, but nothing in the UI
 * touched it. Step 2 makes the store authoritative for **panel-tree structure**:
 * the four structural mutations (split / move-tab / merge-a-tab / split-with-tab)
 * dispatch `layout.*` intents instead of editing `appStore.rootPanel` locally,
 * and the resulting projection diff is reconciled back into `appStore`'s
 * existing panel-tree shape so `SplitView` renders exactly as before (rendering
 * is cut over in step 3, the reducers removed in step 4).
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
 * The cut is gated by {@link layoutIntentsEnabled} — **off by default**, so the
 * shipped app keeps running on the untouched local reducers until step 3 flips
 * rendering over too. Even when enabled, any dispatch/reconcile failure falls
 * back to the local mutation, so a backend hiccup can never break layout.
 */

import {
  createTransport,
  newClientId,
  newIntentId,
  ProjectionClient,
  type IntentAck,
  type Transport,
} from "@/services/transport";
import type { DropEdge, LeafPanel, PanelNode, SplitContainer, TerminalTab } from "@/types/terminal";
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
type MinimalNode = MinimalLeaf | MinimalSplit;

/** The `layout@<clientId>` region view model: tree + focused panel. */
interface LayoutView {
  root: MinimalNode;
  activePanelId: string | null;
}

// ── Feature flag (runtime-flippable so a dev build can verify the ON path) ─────

interface LayoutFlagWindow {
  __TERMIHUB_LAYOUT_INTENTS__?: boolean;
  localStorage?: Storage;
}

let flagOverride: boolean | null = null;

/**
 * Programmatic override for the layout-intents flag (tests, and a runtime
 * toggle). `null` clears the override and falls back to the window/localStorage
 * signal, then to the default.
 */
export function setLayoutIntentsEnabled(value: boolean | null): void {
  flagOverride = value;
}

/**
 * Whether structural layout mutations route through `layout.*` intents (step 2)
 * instead of mutating `appStore.rootPanel` locally.
 *
 * **Off by default.** Step 2 lands the machinery gated; step 3 (rendering cut)
 * flips the default on. Overridable at runtime for verification via
 * `window.__TERMIHUB_LAYOUT_INTENTS__` or `localStorage["termihub.layoutIntents"]`.
 */
export function layoutIntentsEnabled(): boolean {
  if (flagOverride !== null) return flagOverride;
  try {
    if (typeof window !== "undefined") {
      const w = window as unknown as LayoutFlagWindow;
      if (typeof w.__TERMIHUB_LAYOUT_INTENTS__ === "boolean") {
        return w.__TERMIHUB_LAYOUT_INTENTS__;
      }
      const ls = w.localStorage?.getItem("termihub.layoutIntents");
      if (ls === "true") return true;
      if (ls === "false") return false;
    }
  } catch {
    // A missing/blocked window or storage just means "use the default".
  }
  return false;
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
 * each tab's rich fields by id from `tabsById` (partial projection: the region
 * carries only structure + minimal tab identity). Per-leaf, `panelId` and
 * `isActive` are re-derived from the projected structure — exactly what the old
 * local reducers set — so `SplitView`'s selectors see an identical shape.
 *
 * Throws if the projection references a tab absent from `tabsById`; the caller
 * treats that as a bridge failure and falls back to the local mutation.
 */
export function reconcileNode(node: MinimalNode, tabsById: Map<string, TerminalTab>): PanelNode {
  if (node.type === "leaf") {
    const tabs: TerminalTab[] = node.tabs.map((mt) => {
      const rich = tabsById.get(mt.id);
      if (!rich) {
        throw new Error(`layout reconcile: unknown tab ${mt.id}`);
      }
      return { ...rich, panelId: node.id, isActive: mt.id === node.activeTabId };
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
    children: node.children.map((c) => reconcileNode(c, tabsById)),
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
