/**
 * Container-level tests for `Sidebar` (issue #2953 / audit finding TFE-007).
 *
 * `Sidebar` is a thin multi-store container: it reads `sidebarView` and
 * `sidebarCollapsed` from the app store and switches which panel subcomponent
 * renders. Each panel (ConnectionList, FileBrowser, TunnelSidebar, …) reads
 * many stores of its own, which is why the container had no test — a full
 * mount pulled in every store at once.
 *
 * The seam here is narrow, so instead of a brittle mega-mock we stub the ten
 * panel subcomponents with inert markers and drive the real app store. That
 * lets us assert the container's own behavior deterministically: the
 * collapsed short-circuit, the header title per view, and — the core contract —
 * that exactly the one panel matching the active `sidebarView` renders and no
 * other. The `data-testid="sidebar"` hook and the optional `width` style are
 * pinned too, since layout code depends on them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore, type SidebarView } from "@/store/appStore";
import { Sidebar } from "./Sidebar";

// Stub every panel subcomponent with an inert marker so the container mounts
// without dragging in each panel's own store dependencies. The specifier paths
// must match Sidebar.tsx exactly (mix of relative + `@/` alias imports). The
// marker element is inlined per factory because `vi.mock` is hoisted above any
// top-level helper.
vi.mock("./ConnectionList", () => ({
  ConnectionList: () => <div data-testid="panel-connections" />,
}));
vi.mock("./FileBrowser", () => ({ FileBrowser: () => <div data-testid="panel-files" /> }));
vi.mock("@/components/TunnelSidebar", () => ({
  TunnelSidebar: () => <div data-testid="panel-tunnels" />,
}));
vi.mock("@/components/WorkspaceSidebar", () => ({
  WorkspaceSidebar: () => <div data-testid="panel-workspaces" />,
}));
vi.mock("@/components/MacroSidebar", () => ({
  MacroSidebar: () => <div data-testid="panel-macros" />,
}));
vi.mock("@/components/RecentSessionsSidebar", () => ({
  RecentSessionsSidebar: () => <div data-testid="panel-recent-sessions" />,
}));
vi.mock("@/components/WorkflowSidebar", () => ({
  WorkflowSidebar: () => <div data-testid="panel-workflows" />,
}));
vi.mock("@/components/NetworkTools/NetworkToolsSidebar", () => ({
  NetworkToolsSidebar: () => <div data-testid="panel-network-tools" />,
}));
vi.mock("@/components/EmbeddedServerSidebar", () => ({
  EmbeddedServerSidebar: () => <div data-testid="panel-services" />,
}));
vi.mock("@/components/Plugins", () => ({
  PluginManagerView: () => <div data-testid="panel-plugins" />,
}));

/** Every view value paired with the panel marker it must render, and its header title. */
const VIEWS: ReadonlyArray<{ view: SidebarView; panelTestid: string; title: string }> = [
  { view: "connections", panelTestid: "panel-connections", title: "Connections" },
  { view: "files", panelTestid: "panel-files", title: "File Browser" },
  { view: "tunnels", panelTestid: "panel-tunnels", title: "SSH Tunnels" },
  { view: "services", panelTestid: "panel-services", title: "Services" },
  { view: "workspaces", panelTestid: "panel-workspaces", title: "Workspaces" },
  { view: "macros", panelTestid: "panel-macros", title: "Macros" },
  { view: "workflows", panelTestid: "panel-workflows", title: "Workflows" },
  { view: "network-tools", panelTestid: "panel-network-tools", title: "Network Tools" },
  { view: "recent-sessions", panelTestid: "panel-recent-sessions", title: "Recent Sessions" },
  { view: "plugins", panelTestid: "panel-plugins", title: "Plugins" },
];

const ALL_PANEL_TESTIDS = VIEWS.map((v) => v.panelTestid);

let container: HTMLDivElement;
let root: Root;

function renderSidebar(props: { width?: number } = {}): void {
  act(() => {
    root.render(<Sidebar {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Sidebar container (#2953)", () => {
  it("renders nothing when the sidebar is collapsed", () => {
    act(() => {
      useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: true });
    });
    renderSidebar();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
    // No panel leaks through the collapse short-circuit either.
    for (const testid of ALL_PANEL_TESTIDS) {
      expect(container.querySelector(`[data-testid="${testid}"]`)).toBeNull();
    }
  });

  it("renders the sidebar shell (header + content) when expanded", () => {
    act(() => {
      useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: false });
    });
    renderSidebar();

    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.querySelector(".sidebar__header")).not.toBeNull();
    expect(container.querySelector(".sidebar__content")).not.toBeNull();
  });

  for (const { view, panelTestid, title } of VIEWS) {
    it(`renders only the ${view} panel and its title for sidebarView="${view}"`, () => {
      act(() => {
        useAppStore.setState({ sidebarView: view, sidebarCollapsed: false });
      });
      renderSidebar();

      // The matching panel renders.
      expect(container.querySelector(`[data-testid="${panelTestid}"]`)).not.toBeNull();

      // Every other panel stays out of the DOM (mutually exclusive switch).
      for (const other of ALL_PANEL_TESTIDS) {
        if (other === panelTestid) continue;
        expect(container.querySelector(`[data-testid="${other}"]`)).toBeNull();
      }

      // The header shows the view's human title.
      const titleEl = container.querySelector(".sidebar__title");
      expect(titleEl?.textContent).toBe(title);
    });
  }

  it("reacts to a live sidebarView change without remounting the shell", () => {
    act(() => {
      useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: false });
    });
    renderSidebar();
    expect(container.querySelector('[data-testid="panel-connections"]')).not.toBeNull();

    act(() => {
      useAppStore.setState({ sidebarView: "macros" });
    });

    expect(container.querySelector('[data-testid="panel-connections"]')).toBeNull();
    expect(container.querySelector('[data-testid="panel-macros"]')).not.toBeNull();
    expect(container.querySelector(".sidebar__title")?.textContent).toBe("Macros");
  });

  it("collapses live when sidebarCollapsed flips to true", () => {
    act(() => {
      useAppStore.setState({ sidebarView: "tunnels", sidebarCollapsed: false });
    });
    renderSidebar();
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();

    act(() => {
      useAppStore.setState({ sidebarCollapsed: true });
    });
    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
  });

  it("applies an explicit width to the sidebar element and omits the style when unset", () => {
    act(() => {
      useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: false });
    });
    renderSidebar({ width: 320 });

    const el = container.querySelector<HTMLDivElement>('[data-testid="sidebar"]');
    expect(el?.style.width).toBe("320px");

    // Re-render with no width: the inline width must not be set.
    renderSidebar({});
    const elNoWidth = container.querySelector<HTMLDivElement>('[data-testid="sidebar"]');
    expect(elNoWidth?.style.width).toBe("");
  });
});
