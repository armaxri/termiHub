/**
 * Watch the window's device pixel ratio (#5065).
 *
 * The ratio changes when the window moves to a monitor with another scale, the
 * display scale is changed, or the WebView settles on its real scale after
 * start-up. None of that changes the terminal container's CSS size, so the
 * `ResizeObserver` never fires — but the WebGL renderer floors its cell to
 * whole device pixels, so its cell width (and the grid that fits the pane)
 * changes with the ratio. The terminal re-fits on this signal.
 *
 * Two sources, as xterm uses for its own renderer: the `(resolution: Ndppx)`
 * media query (re-armed for each new ratio) and the window `resize` event.
 * The callback runs once per actual change.
 */

/** Stops a {@link watchDevicePixelRatio} watch. */
export type StopWatch = () => void;

/** Call `onChange(ratio)` whenever `win.devicePixelRatio` changes. */
export function watchDevicePixelRatio(win: Window, onChange: (ratio: number) => void): StopWatch {
  let current = win.devicePixelRatio;
  let query: MediaQueryList | null = null;
  let stopped = false;

  const check = (): void => {
    if (stopped) return;
    const next = win.devicePixelRatio;
    if (next !== current) {
      current = next;
      arm();
      onChange(next);
    }
  };

  function arm(): void {
    query?.removeEventListener("change", check);
    query =
      typeof win.matchMedia === "function" ? win.matchMedia(`(resolution: ${current}dppx)`) : null;
    query?.addEventListener("change", check);
  }

  arm();
  win.addEventListener("resize", check);
  return () => {
    stopped = true;
    query?.removeEventListener("change", check);
    query = null;
    win.removeEventListener("resize", check);
  };
}
