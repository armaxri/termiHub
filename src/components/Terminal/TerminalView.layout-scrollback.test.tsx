/**
 * Layout GUI-smoke automation (#2561): a structural layout op must preserve the
 * live terminal scrollback.
 *
 * After the stateless-UI inversion the scrollback bytes live *only* in the
 * tab-id-keyed xterm held by `TerminalRegistry`; a `<Terminal key={tab.id}>` is
 * mounted once by `TerminalHost` in a stable spot spanning **every** tab group
 * (active and inactive), and `SplitView`'s `TerminalSlot` merely reparents that
 * one DOM element into the visible panel. So the render-path guarantee for
 * "scrollback survives a split / drag-to-edge / drag-to-center / cross-panel
 * move / merge / tab-move-across-groups / group-switch" reduces to a single
 * keying invariant: **as long as an op preserves `tab.id`, `TerminalHost` must
 * not remount that terminal** — because a remount is exactly what disposes the
 * live xterm and loses its scrollback.
 *
 * This suite proves that invariant directly and headlessly (no display, no VM,
 * deterministic in per-PR CI). It renders the real `TerminalHost` with a stub
 * `<Terminal>` that faithfully models the xterm/scrollback lifecycle: on mount
 * it acquires a unique scrollback token + sentinel content, on unmount it loses
 * them. Each of the seven layout ops is applied as the structural tree/group
 * transition it produces (all preserving the tab-id set), and the suite asserts
 * every surviving terminal keeps the *same* token and sentinel across the op —
 * i.e. its live xterm was never torn down, so its scrollback survived.
 *
 * A control case (closing a tab) shows the probe genuinely detects a teardown,
 * so the "no remount" assertions are not vacuous.
 *
 * This is the automated replacement for the display-gated manual "layout
 * GUI-smoke matrix" grade in #2561 (see docs/testing.md).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { createLeafPanel, splitLeaf } from "@/utils/panelTree";
import type { LeafPanel, PanelNode, TabGroup, TerminalTab } from "@/types/terminal";

// ── The live-scrollback probe ────────────────────────────────────────────────
// Models what a real <Terminal> does to the scrollback across its lifecycle: a
// fresh xterm (and thus a fresh ring buffer) is created on mount and disposed on
// unmount. `token` is a per-mount identity — a stable token across an op proves
// the SAME live terminal (same xterm, same scrollback) survived; a changed or
// missing token proves a remount/teardown (scrollback lost).
interface LiveScrollback {
  token: number;
  content: string;
}
const liveScrollback = new Map<string, LiveScrollback>();
const mountCounter = { n: 0 };

vi.mock("./Terminal", () => ({
  Terminal: ({ tabId }: { tabId: string }) => {
    useEffect(() => {
      const token = ++mountCounter.n;
      liveScrollback.set(tabId, { token, content: `SCROLLBACK::${tabId}` });
      return () => {
        liveScrollback.delete(tabId);
      };
    }, [tabId]);
    return <div data-testid={`term-${tabId}`} />;
  },
}));

// Keep TerminalView's import graph light and side-effect-free in jsdom.
vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
  getXtermTheme: vi.fn(() => ({})),
}));

import { TerminalHost } from "./TerminalView";
import { seedLayoutState } from "@/test/layoutState";

// ── Tree/group builders ──────────────────────────────────────────────────────
function termTab(id: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "a",
    isActive: false,
  } as TerminalTab;
}

function leaf(id: string, tabIds: string[]): LeafPanel {
  return {
    type: "leaf",
    id,
    tabs: tabIds.map(termTab),
    activeTabId: tabIds[0] ?? null,
  };
}

function split(direction: "horizontal" | "vertical", children: PanelNode[]): PanelNode {
  return { type: "split", id: `split-${children.map((c) => c.id).join("-")}`, direction, children };
}

const G1 = "group-1";
const G2 = "group-2";

/** Seed: t1,t2 in the active group (G1); t3 alone in an inactive group (G2). */
function seed(): { rootPanel: PanelNode; tabGroups: TabGroup[]; activeTabGroupId: string } {
  const active = leaf("a", ["t1", "t2"]);
  return {
    rootPanel: active,
    activeTabGroupId: G1,
    tabGroups: [
      { id: G1, name: "G1", rootPanel: active, activePanelId: "a" },
      { id: G2, name: "G2", rootPanel: leaf("b", ["t3"]), activePanelId: "b" },
    ],
  };
}

type Layout = ReturnType<typeof seed>;

function applyLayout(layout: Layout): void {
  act(() => {
    seedLayoutState({
      rootPanel: layout.rootPanel,
      tabGroups: layout.tabGroups,
      activeTabGroupId: layout.activeTabGroupId,
    });
  });
}

/** A group list with G1's active tree = `activeRoot` and G2 holding `g2Root`. */
function groups(activeRoot: PanelNode, g2Root: PanelNode): TabGroup[] {
  return [
    { id: G1, name: "G1", rootPanel: activeRoot, activePanelId: "a" },
    { id: G2, name: "G2", rootPanel: g2Root, activePanelId: "b" },
  ];
}

/** The seven layout ops, each as the tab-id-preserving structural transition it
 * produces at the render layer. Every case keeps the full {t1,t2,t3} set, so no
 * terminal may remount. */
const OPS: { name: string; next: () => Layout }[] = [
  {
    // split the active panel → an empty sibling panel appears; nothing moves.
    name: "split",
    next: () => {
      const root = splitLeaf(
        leaf("a", ["t1", "t2"]),
        "a",
        createLeafPanel(),
        "horizontal",
        "after"
      );
      return { rootPanel: root, activeTabGroupId: G1, tabGroups: groups(root, leaf("b", ["t3"])) };
    },
  },
  {
    // drag t2 to the right EDGE → new horizontal split, t2 in its own panel.
    name: "drag-to-edge",
    next: () => {
      const root = split("horizontal", [leaf("a", ["t1"]), leaf("edge", ["t2"])]);
      return { rootPanel: root, activeTabGroupId: G1, tabGroups: groups(root, leaf("b", ["t3"])) };
    },
  },
  {
    // drag t2 to the CENTER of a sibling panel → t2 joins that panel's stack
    // (t1 stays behind in its own panel). t1,t2,t3 must all still survive.
    name: "drag-to-center",
    next: () => {
      const root = split("horizontal", [leaf("a", ["t1"]), leaf("center", ["t2"])]);
      return { rootPanel: root, activeTabGroupId: G1, tabGroups: groups(root, leaf("b", ["t3"])) };
    },
  },
  {
    // move t1 across panels into t2's panel (both stay in the active group).
    name: "cross-panel move",
    next: () => {
      const root = leaf("c", ["t2", "t1"]);
      return { rootPanel: root, activeTabGroupId: G1, tabGroups: groups(root, leaf("b", ["t3"])) };
    },
  },
  {
    // merge a split back to a single panel (the inverse of split); ids intact.
    name: "merge",
    next: () => {
      const root = leaf("a", ["t1", "t2"]);
      return { rootPanel: root, activeTabGroupId: G1, tabGroups: groups(root, leaf("b", ["t3"])) };
    },
  },
  {
    // move t2 from the active group (G1) into the inactive group (G2). t2 is now
    // in an inactive group but TerminalHost still mounts it — the #2512 headline.
    name: "tab-move-across-groups",
    next: () => {
      const active = leaf("a", ["t1"]);
      return {
        rootPanel: active,
        activeTabGroupId: G1,
        tabGroups: groups(active, leaf("b", ["t3", "t2"])),
      };
    },
  },
  {
    // switch the active group to G2. All terminals stay mounted (both groups).
    name: "group-switch",
    next: () => {
      const g2 = leaf("b", ["t3"]);
      return {
        rootPanel: g2,
        activeTabGroupId: G2,
        tabGroups: [
          { id: G1, name: "G1", rootPanel: leaf("a", ["t1", "t2"]), activePanelId: "a" },
          { id: G2, name: "G2", rootPanel: g2, activePanelId: "b" },
        ],
      };
    },
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  liveScrollback.clear();
  mountCounter.n = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mountSeeded(): void {
  applyLayout(seed());
  act(() => {
    root.render(<TerminalHost />);
  });
}

/** The live scrollback tokens keyed by tab id, snapshotted for comparison. */
function tokens(): Record<string, LiveScrollback | undefined> {
  return {
    t1: liveScrollback.get("t1"),
    t2: liveScrollback.get("t2"),
    t3: liveScrollback.get("t3"),
  };
}

describe("TerminalHost — a layout op preserves live terminal scrollback (#2561)", () => {
  it("mounts every terminal across active AND inactive groups exactly once", () => {
    mountSeeded();
    // t1,t2 (active group) + t3 (inactive group) are all live — the inactive one
    // proves TerminalHost spans all groups, so group ops cannot remount it.
    expect(liveScrollback.get("t1")).toMatchObject({ content: "SCROLLBACK::t1" });
    expect(liveScrollback.get("t2")).toMatchObject({ content: "SCROLLBACK::t2" });
    expect(liveScrollback.get("t3")).toMatchObject({ content: "SCROLLBACK::t3" });
    expect(mountCounter.n).toBe(3); // no double-mounts
  });

  for (const op of OPS) {
    it(`preserves every terminal's live scrollback across: ${op.name}`, () => {
      mountSeeded();
      const before = tokens();

      applyLayout(op.next());

      const after = tokens();
      // Same token ⇒ the SAME live xterm instance survived ⇒ scrollback intact.
      for (const id of ["t1", "t2", "t3"] as const) {
        expect(after[id], `${id} must still be live after ${op.name}`).toBeDefined();
        expect(after[id]!.token, `${id} must not be remounted by ${op.name}`).toBe(
          before[id]!.token
        );
        expect(after[id]!.content).toBe(`SCROLLBACK::${id}`);
      }
      // No terminal was torn down and recreated anywhere.
      expect(mountCounter.n).toBe(3);
    });
  }

  it("control: closing a tab DOES tear down its scrollback (probe is not vacuous)", () => {
    mountSeeded();
    const before = tokens();

    // Close t3 entirely: drop group G2. t3 is no longer rendered anywhere.
    applyLayout({
      rootPanel: leaf("a", ["t1", "t2"]),
      activeTabGroupId: G1,
      tabGroups: [{ id: G1, name: "G1", rootPanel: leaf("a", ["t1", "t2"]), activePanelId: "a" }],
    });

    expect(liveScrollback.get("t3"), "closed tab's scrollback is gone").toBeUndefined();
    // The survivors are untouched — the op only tore down the closed tab.
    expect(liveScrollback.get("t1")!.token).toBe(before.t1!.token);
    expect(liveScrollback.get("t2")!.token).toBe(before.t2!.token);
  });
});
