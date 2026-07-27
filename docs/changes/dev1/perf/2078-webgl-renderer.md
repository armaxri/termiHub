# Changes

## Added

- GPU-accelerated terminal rendering via the `@xterm/addon-webgl` WebGL2
  renderer, the single biggest render-throughput win on high-volume output
  (#2078). The renderer degrades gracefully to the DOM renderer if the WebView
  cannot create a WebGL2 context or the GPU context is lost at runtime, so the
  terminal never goes blank.
