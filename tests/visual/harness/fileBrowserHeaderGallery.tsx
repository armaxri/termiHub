/**
 * Gallery of the file browser's header (#5520, #5521): the real path bar and
 * action row, fed long local, long remote and deep Windows paths, in sidebar-
 * wide cells at the default and the minimum sidebar width, in the theme named
 * by `?theme=` (`dark` default, `light`, `solarized-dark`, `solarized-light`).
 * Audited and screenshotted by tests/visual/fileBrowserHeader.spec.ts.
 */

import React from "react";
import ReactDOM from "react-dom/client";

import "../../../src/styles/global.css";
import "../../../src/components/Sidebar/FileBrowser.css";
import { applyTheme } from "../../../src/themes/engine";
import { TooltipProvider } from "../../../src/components/ui";
import { FileBrowserActions } from "../../../src/components/Sidebar/FileBrowserActions";
import { FileBrowserDndProvider } from "../../../src/components/Sidebar/FileBrowserDndProvider";
import { FileBrowserPathBar } from "../../../src/components/Sidebar/FileBrowserPathBar";
import { buildFileBrowserActions } from "../../../src/components/Sidebar/fileBrowserHeaderActions";

const THEMES = ["dark", "light", "solarized-dark", "solarized-light"];
const requested = new URLSearchParams(location.search).get("theme") ?? "dark";
const theme = THEMES.includes(requested) ? requested : "dark";
applyTheme(theme);

/** One header to render. */
interface HeaderCell {
  id: string;
  title: string;
  path: string;
  mode: "local" | "session";
  /** Sidebar width in CSS pixels (260 = default, 200 = the resize minimum). */
  width: number;
  /** The file clipboard holds entries (Paste shows inline). */
  clipboard?: boolean;
}

const LONG_LOCAL = "/Users/arne/work/git/termiHubDev/dev2/termiHub/src/components/Sidebar";
const LONG_REMOTE = "/var/www/vhosts/example.com/releases/2026-11-13T00-41-12Z/public/assets/img";
const DEEP_WINDOWS =
  "C:/Users/Administrator/AppData/Local/Programs/termiHub/resources/plugins/ssh-tools";

const CELLS: HeaderCell[] = [
  { id: "short-local", title: "Short local path", path: "/home/visual", mode: "local", width: 260 },
  { id: "long-local", title: "Long local path", path: LONG_LOCAL, mode: "local", width: 260 },
  {
    id: "long-remote",
    title: "Long remote path, clipboard full",
    path: LONG_REMOTE,
    mode: "session",
    width: 260,
    clipboard: true,
  },
  { id: "deep-windows", title: "Deep Windows path", path: DEEP_WINDOWS, mode: "local", width: 260 },
  {
    id: "long-leaf",
    title: "Leaf wider than the bar",
    path: "/srv/a-folder-name-that-is-much-wider-than-the-whole-sidebar-path-bar",
    mode: "local",
    width: 260,
  },
  {
    id: "narrow-local",
    title: "Long local path, narrow",
    path: LONG_LOCAL,
    mode: "local",
    width: 200,
  },
  {
    id: "narrow-remote",
    title: "Long remote path, narrow",
    path: LONG_REMOTE,
    mode: "session",
    width: 200,
    clipboard: true,
  },
  {
    id: "narrow-windows",
    title: "Deep Windows path, narrow",
    path: DEEP_WINDOWS,
    mode: "local",
    width: 200,
  },
];

const noop = () => {};

function Header({ cell }: { cell: HeaderCell }) {
  const actions = buildFileBrowserActions({
    mode: cell.mode,
    currentPath: cell.path,
    isLoading: false,
    reducedMotion: false,
    hasCwd: true,
    canCd: true,
    showHiddenFiles: false,
    vscodeAvailable: true,
    fileManagerLabel: "Reveal in Finder",
    pasteTooltip: cell.clipboard ? 'Paste "report.pdf" (copy)' : null,
    bookmarksMenu: null,
    onNavigateUp: noop,
    onNavigateToCwd: noop,
    onCdHere: noop,
    onRefresh: noop,
    onOpenTransferView: noop,
    onToggleHidden: noop,
    onOpenInFileManager: noop,
    onOpenInVscode: noop,
    onUpload: noop,
    onPaste: noop,
    onNewFile: noop,
    onNewFolder: noop,
  });
  return (
    <figure className="fbg-cell" data-testid={`fbg-cell-${cell.id}`} data-path={cell.path}>
      <figcaption className="fbg-caption">
        {cell.title} · {cell.width}px
      </figcaption>
      <div className="fbg-sidebar file-browser" style={{ width: cell.width }}>
        <div className="file-browser__toolbar">
          <FileBrowserPathBar currentPath={cell.path} onNavigate={noop} />
          <FileBrowserActions actions={actions} />
        </div>
      </div>
    </figure>
  );
}

const GALLERY_CSS = `
  body { font-family: var(--font-family); color: var(--text-primary); background: var(--bg-primary); }
  .fbg { display: grid; grid-template-columns: repeat(2, max-content); gap: 20px 32px; padding: 20px; width: max-content; background: var(--bg-primary); }
  .fbg-cell { margin: 0; }
  .fbg-caption { font-size: 12px; color: var(--text-secondary); margin: 0 0 6px; }
  .fbg-sidebar { height: auto; background: var(--bg-secondary); border: 1px solid var(--border-primary); box-sizing: content-box; }
`;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <style>{GALLERY_CSS}</style>
    <TooltipProvider>
      <FileBrowserDndProvider onDrop={noop}>
        <div className="fbg" data-testid="file-browser-header-gallery" data-theme={theme}>
          {CELLS.map((c) => (
            <Header key={c.id} cell={c} />
          ))}
        </div>
      </FileBrowserDndProvider>
    </TooltipProvider>
  </React.StrictMode>
);
