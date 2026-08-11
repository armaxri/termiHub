/**
 * Test harness for the client-scoped `layout@<clientId>` projection region
 * (#2151 / #2283 slice D').
 *
 * {@link FakeLayoutTransport} is an in-memory twin of the Rust `LayoutStore`: it
 * folds the granular `layout.*` intents exactly as the backend routes them
 * (mirroring `src-tauri/src/layout/store.rs`) over a multi-group view
 * `{ groups, activeGroupId }`, and fans a fresh snapshot to every subscriber. It
 * lets a test drive `appStore`'s layout reducers through the **real**
 * {@link import("@/store/layoutBridge").mirrorLayoutIntent} path — the optimistic
 * overlay applies synchronously, and this fake backend supplies the authoritative
 * diff that reconciles (prunes) it.
 *
 * Because the reducers stay authoritative for `appStore.rootPanel` under slice D'
 * (the fallback removal is still gated on #2283), tests assert two things: the
 * local tree lands in `appStore.rootPanel` synchronously, and the projected region
 * view (via {@link import("@/store/layoutBridge").currentLayoutView}) tracks it.
 */

import type {
  FrameHandler,
  Intent,
  IntentAck,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import {
  createLeafPanel,
  edgeToSplit,
  findLeaf,
  findLeafByTab,
  generatePanelId,
  getAllLeaves,
  normalizeSizes,
  removeLeaf,
  simplifyTree,
  splitLeaf,
  updateLeaf,
} from "@/utils/panelTree";
import type { DropEdge, LeafPanel, PanelNode } from "@/types/terminal";

import { setLayoutTransportForTest, stopLayoutSubscription } from "@/store/layoutBridge";

/** A minimal projected tab (twin of the Rust `Tab`). */
export interface MinimalTab {
  id: string;
  sessionId?: string | null;
  contentType: string;
}

/** One projected tab group (twin of the Rust `GroupLayout`). */
export interface GroupView {
  id: string;
  name: string;
  color?: string;
  root: PanelNode;
  activePanelId: string | null;
}

/** The full multi-group region view (twin of the Rust `ClientLayout`). */
export interface FullLayoutView {
  groups: GroupView[];
  activeGroupId: string;
}

let fakeGroupCounter = 0;

/** A minimal-view tab removal with the positional active fallback (Rust parity). */
function removeTabMinimal(leaf: LeafPanel, tabId: string): LeafPanel {
  const idx = leaf.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return leaf;
  const tabs = leaf.tabs.filter((t) => t.id !== tabId);
  let activeTabId = leaf.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = tabs.length ? tabs[Math.min(idx, tabs.length - 1)].id : null;
  }
  return { ...leaf, tabs, activeTabId };
}

/** Repoint a group's focus at an existing leaf when the current one is gone. */
function fixActive(group: GroupView): GroupView {
  const present = group.activePanelId && findLeaf(group.root, group.activePanelId);
  if (present) return group;
  return { ...group, activePanelId: getAllLeaves(group.root)[0]?.id ?? null };
}

/**
 * An in-memory substrate double for the `layout@<clientId>` region: holds one
 * multi-group view, folds the granular `layout.*` intents like the Rust store, and
 * fans a snapshot to every subscriber.
 */
export class FakeLayoutTransport implements Transport {
  dispatched: Intent[] = [];
  /** When `true`, every dispatch is rejected — drives the rollback path. */
  reject = false;

  private view: FullLayoutView = {
    groups: [{ id: "g-seed", name: "Main", root: createLeafPanel(), activePanelId: null }],
    activeGroupId: "g-seed",
  };
  private version = 0;
  private handlers = new Set<FrameHandler>();
  private region = "";

  /** Intent kinds dispatched, in order (assertion helper). */
  kinds(): string[] {
    return this.dispatched.map((i) => i.kind);
  }

  /** The current projected multi-group view (assertion helper). */
  regionView(): FullLayoutView {
    return structuredClone(this.view);
  }

  /** The active group of the current view (assertion helper). */
  activeGroup(): GroupView {
    return this.view.groups.find((g) => g.id === this.view.activeGroupId) ?? this.view.groups[0];
  }

  /** Seed the region view directly (test setup), fanning a snapshot. */
  seed(view: FullLayoutView): void {
    this.view = structuredClone(view);
    this.bump();
  }

  private groupFor(groupId: string | undefined): GroupView {
    if (groupId) return this.view.groups.find((g) => g.id === groupId) ?? this.activeGroup();
    return this.activeGroup();
  }

  private setGroup(next: GroupView): void {
    this.view.groups = this.view.groups.map((g) => (g.id === next.id ? next : g));
  }

  private setRoot(group: GroupView, root: PanelNode, activePanelId: string | null): void {
    this.setGroup(fixActive({ ...group, root, activePanelId }));
  }

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (this.reject) {
      return {
        intentId: intent.intentId,
        status: "rejected",
        error: { code: "x", message: "nope" },
      };
    }
    const p = intent.payload as Record<string, unknown>;
    const gid = p.groupId as string | undefined;
    switch (intent.kind) {
      case "layout.replaceGroups":
        this.view = {
          groups: structuredClone(p.groups as GroupView[]),
          activeGroupId: p.activeGroupId as string,
        };
        break;
      case "layout.split": {
        const g = this.groupFor(gid);
        const newLeaf = createLeafPanel();
        let root = splitLeaf(
          g.root,
          p.panelId as string,
          newLeaf,
          p.direction as "horizontal" | "vertical",
          p.position as "before" | "after"
        );
        root = simplifyTree(root);
        this.setRoot(g, root, newLeaf.id);
        break;
      }
      case "layout.moveTab": {
        const g = this.groupFor(gid);
        const tabId = p.tabId as string;
        const target = p.targetPanelId as string;
        const src = findLeafByTab(g.root, tabId);
        if (!src) return this.rejectAck(intent, "tab_not_found");
        const theTab = src.tabs.find((t) => t.id === tabId);
        if (!theTab) return this.rejectAck(intent, "tab_not_found");
        let root = updateLeaf(g.root, src.id, (leaf) => removeTabMinimal(leaf, tabId));
        const splitInfo = edgeToSplit(p.edge as DropEdge);
        if (!splitInfo) {
          root = updateLeaf(root, target, (leaf) => ({
            ...leaf,
            tabs: [...leaf.tabs, { ...theTab }],
            activeTabId: tabId,
          }));
        } else {
          const newLeaf: LeafPanel = {
            type: "leaf",
            id: generatePanelId(),
            tabs: [{ ...theTab }],
            activeTabId: tabId,
          };
          root = splitLeaf(root, target, newLeaf, splitInfo.direction, splitInfo.position);
        }
        const src2 = findLeaf(root, src.id);
        if (src2 && src2.tabs.length === 0) {
          const removed = removeLeaf(root, src.id);
          root = removed ? simplifyTree(removed) : simplifyTree(root);
        } else {
          root = simplifyTree(root);
        }
        this.setRoot(g, root, g.activePanelId);
        break;
      }
      case "layout.removePanel": {
        const g = this.groupFor(gid);
        if (getAllLeaves(g.root).length <= 1) break;
        const removed = removeLeaf(g.root, p.panelId as string);
        this.setRoot(g, removed ? simplifyTree(removed) : g.root, g.activePanelId);
        break;
      }
      case "layout.reorderTabs": {
        const g = this.groupFor(gid);
        const root = updateLeaf(g.root, p.panelId as string, (leaf) => {
          const tabs = [...leaf.tabs];
          const [moved] = tabs.splice(p.oldIndex as number, 1);
          tabs.splice(p.newIndex as number, 0, moved);
          return { ...leaf, tabs };
        });
        this.setRoot(g, root, g.activePanelId);
        break;
      }
      case "layout.setActivePanel": {
        const g = this.groupFor(gid);
        if (!findLeaf(g.root, p.panelId as string))
          return this.rejectAck(intent, "panel_not_found");
        this.setRoot(g, g.root, p.panelId as string);
        break;
      }
      case "layout.setActiveTab": {
        const g = this.groupFor(gid);
        const tabId = p.tabId as string;
        const leaf = findLeafByTab(g.root, tabId);
        if (!leaf) return this.rejectAck(intent, "tab_not_found");
        const root = updateLeaf(g.root, leaf.id, (l) => ({
          ...l,
          tabs: l.tabs.map((t) => ({ ...t, isActive: t.id === tabId })),
          activeTabId: tabId,
        }));
        this.setRoot(g, root, leaf.id);
        break;
      }
      case "layout.resize": {
        const g = this.groupFor(gid);
        const splitId = p.splitId as string;
        const sizes = normalizeSizes(p.sizes as number[]);
        const apply = (n: PanelNode): PanelNode => {
          if (n.type === "leaf") return n;
          const children = n.children.map(apply);
          return n.id === splitId ? { ...n, children, sizes } : { ...n, children };
        };
        this.setRoot(g, apply(g.root), g.activePanelId);
        break;
      }
      case "layout.addTab": {
        const g = this.groupFor(gid);
        const tab = p.tab as MinimalTab;
        const panelId = p.panelId as string;
        if (!findLeaf(g.root, panelId)) return this.rejectAck(intent, "panel_not_found");
        const root = updateLeaf(g.root, panelId, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs, tab as unknown as LeafPanel["tabs"][number]],
          activeTabId: tab.id,
        }));
        this.setRoot(g, root, panelId);
        break;
      }
      case "layout.closeTabStructure": {
        const g = this.groupFor(gid);
        const tabId = p.tabId as string;
        const leaf = findLeafByTab(g.root, tabId);
        if (!leaf) return this.rejectAck(intent, "tab_not_found");
        let root = updateLeaf(g.root, leaf.id, (l) => removeTabMinimal(l, tabId));
        const after = findLeaf(root, leaf.id);
        if (after && after.tabs.length === 0 && getAllLeaves(root).length > 1) {
          const removed = removeLeaf(root, leaf.id);
          root = removed ? simplifyTree(removed) : root;
        }
        this.setRoot(g, root, g.activePanelId);
        break;
      }
      case "layout.addGroup": {
        const leaf = createLeafPanel();
        const id = `g-fake-${(fakeGroupCounter += 1)}`;
        this.view.groups.push({
          id,
          name: (p.name as string) ?? `Group ${this.view.groups.length + 1}`,
          root: leaf,
          activePanelId: leaf.id,
        });
        this.view.activeGroupId = id;
        break;
      }
      case "layout.closeGroup": {
        const groupId = p.groupId as string;
        if (this.view.groups.length <= 1) return this.rejectAck(intent, "last_group");
        const idx = this.view.groups.findIndex((g) => g.id === groupId);
        if (idx === -1) return this.rejectAck(intent, "group_not_found");
        const wasActive = this.view.activeGroupId === groupId;
        this.view.groups.splice(idx, 1);
        if (wasActive) {
          const newIdx = Math.min(Math.max(0, idx - 1), this.view.groups.length - 1);
          this.view.activeGroupId = this.view.groups[newIdx].id;
        }
        break;
      }
      case "layout.renameGroup": {
        const g = this.view.groups.find((x) => x.id === (p.groupId as string));
        if (!g) return this.rejectAck(intent, "group_not_found");
        this.setGroup({ ...g, name: p.name as string });
        break;
      }
      case "layout.setGroupColor": {
        const g = this.view.groups.find((x) => x.id === (p.groupId as string));
        if (!g) return this.rejectAck(intent, "group_not_found");
        const color = p.color as string | undefined;
        const next: GroupView = { ...g };
        if (color != null) next.color = color;
        else delete next.color;
        this.setGroup(next);
        break;
      }
      case "layout.setActiveGroup": {
        const groupId = p.groupId as string;
        if (!this.view.groups.some((g) => g.id === groupId)) {
          return this.rejectAck(intent, "group_not_found");
        }
        this.view.activeGroupId = groupId;
        break;
      }
      case "layout.reorderGroups": {
        const groups = [...this.view.groups];
        const [moved] = groups.splice(p.fromIndex as number, 1);
        groups.splice(p.toIndex as number, 0, moved);
        this.view.groups = groups;
        break;
      }
      case "layout.moveTabToGroup": {
        const targetGroupId = p.targetGroupId as string;
        if (targetGroupId === this.view.activeGroupId) break;
        const target = this.view.groups.find((g) => g.id === targetGroupId);
        if (!target) return this.rejectAck(intent, "group_not_found");
        const active = this.activeGroup();
        const tabId = p.tabId as string;
        const from = p.fromPanelId as string;
        const src = findLeaf(active.root, from);
        const theTab = src?.tabs.find((t) => t.id === tabId);
        if (!theTab) return this.rejectAck(intent, "tab_not_found");
        let root = updateLeaf(active.root, from, (leaf) => removeTabMinimal(leaf, tabId));
        const after = findLeaf(root, from);
        if (after && after.tabs.length === 0 && getAllLeaves(root).length > 1) {
          const removed = removeLeaf(root, from);
          root = removed ? simplifyTree(removed) : root;
        }
        this.setGroup(fixActive({ ...active, root }));
        const firstLeaf = getAllLeaves(target.root)[0];
        const targetRoot = updateLeaf(target.root, firstLeaf.id, (leaf) => ({
          ...leaf,
          tabs: [...leaf.tabs, { ...theTab }],
          activeTabId: theTab.id,
        }));
        this.setGroup({ ...target, root: targetRoot });
        break;
      }
      case "layout.addGroupWithTab": {
        const active = this.activeGroup();
        const tabId = p.tabId as string;
        const from = p.fromPanelId as string;
        const src = findLeaf(active.root, from);
        const theTab = src?.tabs.find((t) => t.id === tabId);
        if (!theTab) return this.rejectAck(intent, "tab_not_found");
        let root = updateLeaf(active.root, from, (leaf) => removeTabMinimal(leaf, tabId));
        const after = findLeaf(root, from);
        if (after && after.tabs.length === 0 && getAllLeaves(root).length > 1) {
          const removed = removeLeaf(root, from);
          root = removed ? simplifyTree(removed) : root;
        }
        this.setGroup(fixActive({ ...active, root }));
        const leaf = createLeafPanel();
        leaf.tabs = [{ ...theTab }];
        leaf.activeTabId = theTab.id;
        const id = `g-fake-${(fakeGroupCounter += 1)}`;
        this.view.groups.push({
          id,
          name: `Group ${this.view.groups.length + 1}`,
          root: leaf,
          activePanelId: leaf.id,
        });
        this.view.activeGroupId = id;
        break;
      }
      default:
        // Unknown intent: accept without a fold (no region change).
        return { intentId: intent.intentId, status: "accepted", produced: [] };
    }
    this.bump();
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: this.region, version: this.version }],
    };
  }

  private rejectAck(intent: Intent, code: string): IntentAck {
    return { intentId: intent.intentId, status: "rejected", error: { code, message: code } };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.region = region;
    this.handlers.add(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => this.handlers.delete(onFrame),
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private bump(): void {
    this.version += 1;
    const frame = this.snapshot(this.region);
    for (const h of this.handlers) h(frame);
  }
}

/**
 * Install a {@link FakeLayoutTransport} as the layout bridge's transport. Returns
 * the transport plus a `teardown` that drops the subscription and restores the
 * real transport — call it in `afterEach`.
 */
export function installLayoutHarness(): {
  transport: FakeLayoutTransport;
  teardown: () => void;
} {
  const transport = new FakeLayoutTransport();
  setLayoutTransportForTest(transport);
  return {
    transport,
    teardown: () => {
      stopLayoutSubscription();
      setLayoutTransportForTest(null);
    },
  };
}
