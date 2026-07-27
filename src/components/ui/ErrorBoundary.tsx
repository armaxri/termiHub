import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Custom fallback UI. Receives the caught error and a `reset` callback that
   * clears the boundary so its subtree re-mounts and re-renders (a localized
   * retry). When omitted, a full-height "Something went wrong" panel with a
   * window reload is shown.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /**
   * Human-readable context (e.g. a panel id) prepended to the logged error so a
   * crash can be traced to the boundary that caught it.
   */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches unhandled React rendering errors in its subtree and renders a
 * fallback instead of letting the throw propagate to an ancestor boundary
 * (which would tear the whole tree down).
 *
 * Place a boundary around each independently-recoverable region — e.g. each
 * split-view panel — so one region's render crash is isolated from its
 * siblings. Provide a {@link ErrorBoundaryProps.fallback} that calls its
 * `reset` argument for a localized retry; the default fallback reloads the
 * window and is meant for the app-wide root boundary only.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const scope = this.props.label ? ` (${this.props.label})` : "";
    console.error(`React render error${scope}:`, error, info.componentStack);
  }

  /** Clear the caught error so the subtree is attempted again. */
  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <DefaultErrorFallback error={error} />;
    }
    return this.props.children;
  }
}

/**
 * Full-height fallback for the app-wide root boundary: shows the error and
 * offers a window reload. Panel-level boundaries pass their own compact
 * fallback with a localized retry instead.
 */
function DefaultErrorFallback({ error }: { error: Error }): ReactNode {
  return (
    <div
      role="alert"
      style={{
        padding: 24,
        color: "var(--color-error)",
        background: "var(--bg-primary)",
        fontFamily: "monospace",
        height: "100%",
        overflow: "auto",
      }}
    >
      <h2 style={{ color: "var(--text-primary)" }}>Something went wrong</h2>
      <pre style={{ whiteSpace: "pre-wrap", marginTop: 12 }}>{error.message}</pre>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          marginTop: 8,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        {error.stack}
      </pre>
      <button
        style={{
          marginTop: 16,
          padding: "6px 16px",
          background: "var(--accent-color)",
          color: "var(--text-on-accent)",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
        }}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
