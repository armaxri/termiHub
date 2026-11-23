/**
 * Tab titles keep the part that tells two tabs apart (#5827).
 *
 * The product-run UI review saw the "(2)" duplicate counter cut off and two
 * telnet tabs both reading "sys-pr-tel… Unencrypted". The title is now
 * middle-truncated: only its head ellipsizes, the tail (the end of the name
 * plus the counter) never shrinks, and the unencrypted marker is an icon.
 * jsdom does not lay out, so the shrink contract is pinned on the stylesheet;
 * the head/tail split, the tooltip and the marker are checked on the DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Tab } from "./Tab";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionConfig, TerminalTab } from "@/types/terminal";
import { getTabDisplayTitle } from "@/utils/editorTabTitle";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tabBarCss = readFileSync(join(SRC_DIR, "components/Terminal/TabBar.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `rule ${selector} exists`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

const TELNET: ConnectionConfig = { type: "telnet", config: { host: "127.0.0.1", port: 2323 } };

function makeTab(id: string, title: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "h", username: "u" } },
    panelId: "panel-1",
    isActive: false,
    connectionId: `conn-${title}`,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

function renderTabs(tabs: TerminalTab[]) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <div role="tablist" aria-label="Open sessions" style={{ width: "240px" }}>
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              tab={tab}
              displayTitle={getTabDisplayTitle(tab, tabs)}
              onActivate={() => {}}
              onClose={() => {}}
            />
          ))}
        </div>
      </TooltipProvider>
    );
  });
}

const q = (testid: string) => container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("middle truncation (#5827)", () => {
  it("never shrinks the tail; only the head ellipsizes", () => {
    const tail = ruleBody(tabBarCss, ".tab__title-tail");
    expect(tail).toMatch(/flex:\s*0 0 auto;/);
    const head = ruleBody(tabBarCss, ".tab__title-head");
    expect(head).toMatch(/flex:\s*0 1 auto;/);
    expect(head).toMatch(/min-width:\s*0;/);
    expect(head).toMatch(/text-overflow:\s*ellipsis;/);
    expect(head).toMatch(/overflow:\s*hidden;/);
    // The title lays its head and tail out in a row inside the tab.
    expect(ruleBody(tabBarCss, ".tab__title")).toMatch(/display:\s*flex;/);
  });

  it("keeps the duplicate counter in the never-truncated tail", () => {
    const name = "sys-pr-ssh-dup-0d8db725";
    renderTabs([makeTab("a", name), makeTab("b", name)]);
    expect(q("tab-title-tail-a")!.textContent).toBe("0d8db725");
    expect(q("tab-title-tail-b")!.textContent).toBe("0d8db725 (2)");
    expect(q("tab-title-head-b")!.textContent).toBe("sys-pr-ssh-dup-");
    // The two tails differ, so the narrow tabs stay distinguishable.
    expect(q("tab-title-tail-a")!.textContent).not.toBe(q("tab-title-tail-b")!.textContent);
  });

  it("keeps the counter of a short name in the tail too", () => {
    renderTabs([makeTab("a", "web"), makeTab("b", "web")]);
    expect(q("tab-title-tail-a")).toBeNull();
    expect(q("tab-title-head-b")!.textContent).toBe("web");
    expect(q("tab-title-tail-b")!.textContent).toBe(" (2)");
  });

  it("tells two telnet tabs apart by their tails, not by the marker", () => {
    renderTabs([
      makeTab("a", "sys-pr-telnet-1a2b3c4d", { config: TELNET, connectionType: "telnet" }),
      makeTab("b", "sys-pr-telnet-9f8e7d6c", { config: TELNET, connectionType: "telnet" }),
    ]);
    expect(q("tab-title-tail-a")!.textContent).toBe("1a2b3c4d");
    expect(q("tab-title-tail-b")!.textContent).toBe("9f8e7d6c");
    for (const id of ["a", "b"]) {
      const marker = q(`tab-unencrypted-badge-${id}`)!;
      expect(marker.textContent).toBe("");
      expect(marker.getAttribute("aria-label")).toBe("Unencrypted");
    }
  });

  it("keeps the full title, whole, as the tab's text and tooltip", () => {
    const name = "Production database replica 12";
    renderTabs([makeTab("a", name)]);
    const tab = q("tab-a")!;
    expect(tab.getAttribute("title")).toBe(name);
    expect(tab.querySelector(".tab__title")!.textContent).toBe(name);
  });

  it("names a serial tab's port in its tooltip", () => {
    renderTabs([
      makeTab("a", "sys-pr-serial-virtual-d46c8e21", {
        connectionType: "serial",
        config: { type: "serial", config: { port: "/tmp/ttyV0", baudRate: 115200 } },
      }),
    ]);
    expect(q("tab-a")!.getAttribute("title")).toBe("sys-pr-serial-virtual-d46c8e21 · /tmp/ttyV0");
  });

  it("does not repeat a port the serial title already names", () => {
    renderTabs([
      makeTab("a", "/dev/ttyUSB0", {
        connectionType: "serial",
        config: { type: "serial", config: { port: "/dev/ttyUSB0" } },
      }),
    ]);
    expect(q("tab-a")!.getAttribute("title")).toBe("/dev/ttyUSB0");
  });
});
