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
}

interface CrumbProps {
  label: string;
  path: string;
  isCurrent: boolean;
  onNavigate: (path: string) => void;
}

/**
 * One breadcrumb segment. Besides navigating on click, each segment is a drop
 * target for drag-to-move (PROD-006), so a row can be dragged "up" into any
 * ancestor folder; it highlights valid vs refused drops.
 */
function Crumb({ label, path, isCurrent, onNavigate }: CrumbProps) {
  const { setNodeRef, highlight } = useFileDropTarget(`crumb:${path}`, path);
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`file-browser__crumb${highlight ? ` file-browser__crumb--drop-${highlight}` : ""}`}
      onClick={() => onNavigate(path)}
      disabled={isCurrent}
      aria-current={isCurrent ? "location" : undefined}
      // Per-segment id so a drag can target one ancestor (`dragTo`, #4007).
      data-testid={`file-browser-crumb-${label}`}
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
}: {
  hidden: PathCrumb[];
  onNavigate: (path: string) => void;
}) {
  return (
    <DropdownMenuRoot>
      <Tooltip content="Show collapsed folders" side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="file-browser__crumb"
            aria-label="Show collapsed folders"
            data-testid="file-browser-crumb-overflow"
          >
            …
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={4} data-testid="file-browser-crumb-menu">
        {hidden.map((crumb) => (
          <MenuItem
            key={crumb.path}
            icon={<Folder size={14} />}
            onSelect={() => onNavigate(crumb.path)}
            title={crumb.path}
            data-testid={`file-browser-crumb-menu-${crumb.label}`}
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
 * the row's tooltip (`title`, also what the system harness reads).
 *
 * The decision uses the natural width of every segment, read from an invisible
 * measuring copy, against the row width from a `ResizeObserver` — so it never
 * oscillates with the layout it produces.
 */
export function CollapsingBreadcrumbs({ currentPath, onNavigate }: CollapsingBreadcrumbsProps) {
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
        isCurrent={crumb.path === currentPath}
        onNavigate={onNavigate}
      />
    </span>
  );

  return (
    <nav
      ref={observeNav}
      className="file-browser__breadcrumbs"
      aria-label="Path"
      title={currentPath}
      data-testid="file-browser-current-path"
      data-collapsed={hidden.length > 0 ? hidden.length : undefined}
    >
      {crumbs.slice(0, hiddenStart).map((c, i) => renderCrumb(c, i, i > 0))}
      {hidden.length > 0 && (
        <span className="file-browser__crumb-group" key="collapsed">
          {hiddenStart > 0 && <Sep />}
          <CollapsedCrumbs hidden={hidden} onNavigate={onNavigate} />
        </span>
      )}
      {crumbs.slice(hiddenEnd).map((c, j) => {
        const i = hiddenEnd + j;
        return renderCrumb(c, i, i > 0);
      })}
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
