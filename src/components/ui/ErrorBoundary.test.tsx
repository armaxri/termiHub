import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ErrorBoundary } from "./ErrorBoundary";

const frontendError = vi.fn();
vi.mock("@/utils/frontendLog", () => ({
  frontendError: (...args: unknown[]) => frontendError(...args),
}));

let container: HTMLDivElement;
let root: Root;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

/** A child that throws on render when `shouldThrow` is true. */
function Boom({ shouldThrow, message }: { shouldThrow: boolean; message?: string }) {
  if (shouldThrow) throw new Error(message ?? "kaboom");
  return <div data-testid="boom-ok">alive</div>;
}

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    // React logs caught render errors to console.error; silence to keep output clean.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    consoleErrorSpy.mockRestore();
  });

  it("renders its children unchanged when no error is thrown", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom shouldThrow={false} />
        </ErrorBoundary>
      );
    });
    expect(query("boom-ok")?.textContent).toBe("alive");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the default fallback with the error message when a child throws", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom shouldThrow message="disk on fire" />
        </ErrorBoundary>
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Something went wrong");
    expect(alert?.textContent).toContain("disk on fire");
    expect(query("boom-ok")).toBeNull();
  });

  it("logs the caught error through frontendError, prefixed with the label", () => {
    act(() => {
      root.render(
        <ErrorBoundary label="split-panel-3">
          <Boom shouldThrow message="render blew up" />
        </ErrorBoundary>
      );
    });
    expect(frontendError).toHaveBeenCalledTimes(1);
    const [scope, msg] = frontendError.mock.calls[0];
    expect(scope).toBe("react");
    expect(msg).toContain("(split-panel-3)");
    expect(msg).toContain("render blew up");
  });

  it("renders a custom fallback with the error and lets its reset re-mount the subtree", () => {
    let captured: Error | null = null;
    let doReset: (() => void) | null = null;
    let shouldThrow = true;

    function Tree() {
      return (
        <ErrorBoundary
          fallback={(error, reset) => {
            captured = error;
            doReset = reset;
            return (
              <button data-testid="custom-fallback" onClick={reset}>
                retry: {error.message}
              </button>
            );
          }}
        >
          <Boom shouldThrow={shouldThrow} message="transient" />
        </ErrorBoundary>
      );
    }

    act(() => {
      root.render(<Tree />);
    });
    expect(query("custom-fallback")?.textContent).toContain("transient");
    expect(captured).toBeInstanceOf(Error);
    expect((captured as unknown as Error).message).toBe("transient");

    // Make the child render cleanly and re-render so the boundary holds the
    // non-throwing element (it still shows the fallback while error is set)...
    shouldThrow = false;
    act(() => {
      root.render(<Tree />);
    });
    expect(query("custom-fallback")).not.toBeNull();

    // ...then resetting clears the error and re-mounts the now-healthy subtree.
    act(() => {
      doReset?.();
    });
    expect(query("boom-ok")?.textContent).toBe("alive");
    expect(query("custom-fallback")).toBeNull();
  });

  it("default fallback offers a Reload button", () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom shouldThrow />
        </ErrorBoundary>
      );
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Reload");
  });
});
