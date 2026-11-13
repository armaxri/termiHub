/**
 * Gallery of the transfer view's pane path bars (#5541): the real
 * `TransferPane`, fed long local, long remote and deep Windows paths, at a
 * comfortable and a narrow pane width, in the theme named by `?theme=`
 * (`dark` default, `light`, `solarized-dark`, `solarized-light`). Audited and
 * screenshotted by tests/visual/transferPanePaths.spec.ts.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { DndContext } from "@dnd-kit/core";

import "../../../src/styles/global.css";
import "../../../src/components/TransferView/TransferView.css";
import { applyTheme } from "../../../src/themes/engine";
import { TooltipProvider } from "../../../src/components/ui";
import { TransferPane } from "../../../src/components/TransferView/TransferPane";
import type { PaneListing } from "../../../src/components/TransferView/usePaneListing";
import type { FileEntry } from "../../../src/types/connection";

const THEMES = ["dark", "light", "solarized-dark", "solarized-light"];
const requested = new URLSearchParams(location.search).get("theme") ?? "dark";
const theme = THEMES.includes(requested) ? requested : "dark";
applyTheme(theme);

/** One pane to render. */
interface PaneCell {
  id: string;
  title: string;
  side: "local" | "remote";
  path: string;
  /** Pane width in CSS pixels (the view splits the tab in two). */
  width: number;
  /** Entry paths shown selected (#5591: the selected-row check reads these). */
  selected?: string[];
}

const LONG_LOCAL = "/Users/arne/work/git/termiHubDev/dev2/termiHub/src/components/Sidebar";
const LONG_REMOTE = "/var/www/vhosts/example.com/releases/2026-11-13T00-41-12Z/public/assets/img";
const DEEP_WINDOWS =
  "C:/Users/Administrator/AppData/Local/Programs/termiHub/resources/plugins/ssh-tools";

const CELLS: PaneCell[] = [
  {
    id: "short-local",
    title: "Short local path, one row selected",
    side: "local",
    path: "/home/visual",
    width: 420,
    selected: ["/x/index.html"],
  },
  { id: "long-local", title: "Long local path", side: "local", path: LONG_LOCAL, width: 420 },
  { id: "long-remote", title: "Long remote path", side: "remote", path: LONG_REMOTE, width: 420 },
  { id: "deep-windows", title: "Deep Windows path", side: "local", path: DEEP_WINDOWS, width: 420 },
  { id: "narrow-local", title: "Long local, narrow", side: "local", path: LONG_LOCAL, width: 280 },
  {
    id: "narrow-remote",
    title: "Long remote, narrow",
    side: "remote",
    path: LONG_REMOTE,
    width: 280,
  },
  {
    id: "narrow-windows",
    title: "Deep Windows, narrow",
    side: "local",
    path: DEEP_WINDOWS,
    width: 280,
  },
];

const noopAsync = () => Promise.resolve();
const noop = () => {};

const ENTRIES: FileEntry[] = [
  {
    name: "assets",
    path: "/x/assets",
    isDirectory: true,
    size: 0,
    modified: "",
    permissions: null,
  },
  {
    name: "index.html",
    path: "/x/index.html",
    isDirectory: false,
    size: 2048,
    modified: "",
    permissions: null,
  },
] as FileEntry[];

function listing(path: string): PaneListing {
  return {
    path,
    entries: ENTRIES,
    loading: false,
    error: null,
    navigate: noopAsync,
    refresh: noopAsync,
    up: noopAsync,
  };
}

function Pane({ cell }: { cell: PaneCell }) {
  return (
    <figure className="tpg-cell" data-testid={`tpg-cell-${cell.id}`} data-path={cell.path}>
      <figcaption className="tpg-caption">
        {cell.title} · {cell.width}px
      </figcaption>
      <div className="tpg-pane" style={{ width: cell.width }}>
        <TransferPane
          side={cell.side}
          title={cell.side === "local" ? "Local" : "web-01"}
          listing={listing(cell.path)}
          selected={new Set(cell.selected)}
          onSelectedChange={noop}
          onCopy={noop}
          canCopy
          bookmarkScope={null}
        />
      </div>
    </figure>
  );
}

const GALLERY_CSS = `
  body { font-family: var(--font-family); color: var(--text-primary); background: var(--bg-primary); }
  .tpg { display: grid; grid-template-columns: repeat(2, max-content); gap: 20px 32px; padding: 20px; width: max-content; background: var(--bg-primary); }
  .tpg-cell { margin: 0; }
  .tpg-caption { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; }
  .tpg-pane { display: flex; height: 150px; }
`;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <style>{GALLERY_CSS}</style>
    <TooltipProvider>
      <DndContext>
        <div className="tpg" data-testid="transfer-pane-paths-gallery" data-theme={theme}>
          {CELLS.map((c) => (
            <Pane key={c.id} cell={c} />
          ))}
        </div>
      </DndContext>
    </TooltipProvider>
  </React.StrictMode>
);
