import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder } from "lucide-react";
import {
  DropdownMenuContent,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  MenuItem,
  Tooltip,
} from "@/components/ui";
import { useElementWidth } from "@/hooks/useElementWidth";
import { collapseCrumbs, splitPathSegments, type PathCrumb } from "@/utils/fileBrowserNav";
import { useFileDropTarget } from "./fileBrowserDnd";

/** Props for {@link CollapsingBreadcrumbs}. */
export interface CollapsingBreadcrumbsProps {
  /** The path currently shown by the file browser. */
  currentPath: string;
  /** Navigate the browser to an absolute path. */
  onNavigate: (path: string) => void;
  /**
   * Switch the bar to its path editor (#5540). When set, clicking the leaf
   * (current) folder or the empty space after the segments starts editing;
   * otherwise the leaf is inert.
   */
  onEdit?: () => void;
  /** Prefix of every `data-testid` (default `file-browser`). */
  testIdPrefix?: string;
  /** Accessible name of the breadcrumb `nav` (default "Path"). */
  label?: string;
  /**
   * Whether segments are drag-to-move drop targets (the sidebar file browser,
   * PROD-006). The transfer view's panes copy between sides instead, so their
   * breadcrumbs opt out (default `true`).
   */
  dropTargets?: boolean;
}

interface CrumbProps {
  label: string;
  path: string;
  isLeaf: boolean;
  onNavigate: (path: string) => void;
  onEdit?: () => void;
  testIdPrefix: string;
  dropTargets: boolean;
}

/**
 * One breadcrumb segment. An ancestor navigates on click; the leaf (the folder
 * being shown) opens the path editor instead, when the bar has one (#5540).
 * In the sidebar each segment is also a drop target for drag-to-move
 * (PROD-006), so a row can be dragged "up" into any ancestor folder; it
 * highlights valid vs refused drops.
 */
function Crumb({ label, path, isLeaf, onNavigate, onEdit, testIdPrefix, dropTargets }: CrumbProps) {
  const dropId = dropTargets ? `crumb:${path}` : `${testIdPrefix}-crumb:${path}`;
  const { setNodeRef, highlight } = useFileDropTarget(dropId, path, undefined, !dropTargets);
  const editsPath = isLeaf && !!onEdit;
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`file-browser__crumb${editsPath ? " file-browser__crumb--edit" : ""}${
        highlight ? ` file-browser__crumb--drop-${highlight}` : ""
      }`}
      onClick={() => (isLeaf ? onEdit?.() : onNavigate(path))}
      disabled={isLeaf && !onEdit}
      aria-current={isLeaf ? "location" : undefined}
      aria-description={editsPath ? "Edit path" : undefined}
      // Per-segment id so a drag can target one ancestor (`dragTo`, #4007).
      data-testid={`${testIdPrefix}-crumb-${label}`}
      data-drop-highlight={highlight ?? undefined}
    >
      {label}
    </button>
  );
}

/** Separator chevron between segments. */
function Sep() {
  return <ChevronRight size={11} className="file-browser__crumb-sep" aria-hidden />;
}

/** The "…" segment: a menu of the folded ancestors, nearest the root first. */
function CollapsedCrumbs({
  hidden,
  onNavigate,
  testIdPrefix,
}: {
  hidden: PathCrumb[];
  onNavigate: (path: string) => void;
  testIdPrefix: string;
}) {
  return (
    <DropdownMenuRoot>
      <Tooltip content="Show collapsed folders" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="file-browser__crumb"
            aria-label="Show collapsed folders"
            data-testid={`${testIdPrefix}-crumb-overflow`}
          >
            …
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={4} data-testid={`${testIdPrefix}-crumb-menu`}>
        {hidden.map((crumb) => (
          <MenuItem
            key={crumb.path}
            icon={<Folder size={14} />}
            onSelect={() => onNavigate(crumb.path)}
            title={crumb.path}
            data-testid={`${testIdPrefix}-crumb-menu-${crumb.label}`}
          >
            {crumb.label}
          </MenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * The path as clickable breadcrumb segments (#5521). When the path is wider
 * than its row, the middle segments fold into one "…" (a menu of them) so the
 * leaf folder — and the root, when there is room — stays legible; a leaf wider
 * than the row on its own ellipsizes. The row never scrolls. The full path is
 * the row's tooltip (`title`, also what the system harness reads). Shared by
 * the sidebar file browser and the transfer view's panes (#5541).
 *
 * The decision uses the natural width of every segment, read from an invisible
 * measuring copy, against the row width from a `ResizeObserver` — so it never
 * oscillates with the layout it produces.
 */
export function CollapsingBreadcrumbs({
  currentPath,
  onNavigate,
  onEdit,
  testIdPrefix = "file-browser",
  label = "Path",
  dropTargets = true,
}: CollapsingBreadcrumbsProps) {
  const crumbs = useMemo(() => splitPathSegments(currentPath), [currentPath]);
  const [observeNav, width] = useElementWidth<HTMLElement>();
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [observeMeasure, measureWidth] = useElementWidth<HTMLSpanElement>();
  const setMeasureRef = useCallback(
    (node: HTMLSpanElement | null) => {
      measureRef.current = node;
      observeMeasure(node);
    },
    [observeMeasure]
  );
  const [metrics, setMetrics] = useState<{ widths: number[]; ellipsisWidth: number } | null>(null);

  // Re-measure when the segments change or the copy's own width does (fonts).
  useLayoutEffect(() => {
    const nodes = measureRef.current ? Array.from(measureRef.current.children) : [];
    const widthOf = (el: Element | undefined) => el?.getBoundingClientRect().width ?? 0;
    setMetrics({
      widths: crumbs.map((_, i) => widthOf(nodes[i])),
      ellipsisWidth: widthOf(nodes[crumbs.length]),
    });
  }, [crumbs, measureWidth]);

  const { hiddenStart, hiddenEnd } =
    metrics && metrics.widths.length === crumbs.length && metrics.widths.every((w) => w > 0)
      ? collapseCrumbs({ available: width, ...metrics })
      : { hiddenStart: 0, hiddenEnd: 0 };
  const hidden = crumbs.slice(hiddenStart, hiddenEnd);
  const last = crumbs.length - 1;

  const renderCrumb = (crumb: PathCrumb, i: number, sep: boolean) => (
    <span
      className={`file-browser__crumb-group${i === last ? " file-browser__crumb-group--leaf" : ""}`}
      key={crumb.path}
    >
      {sep && <Sep />}
      <Crumb
        label={crumb.label}
        path={crumb.path}
        isLeaf={i === last}
        onNavigate={onNavigate}
        onEdit={onEdit}
        testIdPrefix={testIdPrefix}
        dropTargets={dropTargets}
      />
    </span>
  );

  return (
    <nav
      ref={observeNav}
      className="file-browser__breadcrumbs"
      aria-label={label}
      title={currentPath}
      data-testid={`${testIdPrefix}-current-path`}
      data-collapsed={hidden.length > 0 ? hidden.length : undefined}
    >
      {crumbs.slice(0, hiddenStart).map((c, i) => renderCrumb(c, i, i > 0))}
      {hidden.length > 0 && (
        <span className="file-browser__crumb-group" key="collapsed">
          {hiddenStart > 0 && <Sep />}
          <CollapsedCrumbs hidden={hidden} onNavigate={onNavigate} testIdPrefix={testIdPrefix} />
        </span>
      )}
      {crumbs.slice(hiddenEnd).map((c, j) => {
        const i = hiddenEnd + j;
        return renderCrumb(c, i, i > 0);
      })}
      {onEdit && (
        // The empty space after the segments: a click there edits the path
        // (#5540). Pointer-only — the leaf segment and the edit shortcut are
        // the keyboard ways in — so it stays out of the tab order and a11y tree.
        <span
          className="file-browser__crumb-fill"
          onClick={onEdit}
          aria-hidden="true"
          data-testid={`${testIdPrefix}-path-edit`}
        />
      )}
      {/* Natural widths of every segment (with its separator) plus the "…". */}
      <span className="file-browser__crumb-measure" ref={setMeasureRef} aria-hidden="true">
        {crumbs.map((crumb, i) => (
          <span className="file-browser__crumb-group" key={crumb.path}>
            {i > 0 && <Sep />}
            <span className="file-browser__crumb">{crumb.label}</span>
          </span>
        ))}
        <span className="file-browser__crumb-group">
          <Sep />
          <span className="file-browser__crumb">…</span>
        </span>
      </span>
    </nav>
  );
}
