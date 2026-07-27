import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/ui";
import "./PanelErrorBoundary.css";

interface PanelErrorBoundaryProps {
  children: ReactNode;
  /** Context for the logged error — the panel id whose subtree is guarded. */
  label?: string;
}

/**
 * Per-panel error boundary. Wrapping each split-view leaf (and the zoom
 * overlay) in its own boundary means a render throw in one panel shows a
 * localized fallback instead of propagating to the app-wide boundary, which
 * would unmount the whole tree and destroy every live session in the other
 * panels. The fallback offers a localized retry that re-mounts only this
 * panel's subtree.
 */
export function PanelErrorBoundary({ children, label }: PanelErrorBoundaryProps) {
  return (
    <ErrorBoundary
      label={label}
      fallback={(error, reset) => (
        <div className="panel-error" role="alert" data-testid="panel-error-boundary">
          <h3 className="panel-error__title">This panel crashed</h3>
          <pre className="panel-error__message">{error.message}</pre>
          <button
            type="button"
            className="panel-error__retry"
            onClick={reset}
            data-testid="panel-error-retry"
          >
            <RotateCcw size={14} />
            Retry
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
