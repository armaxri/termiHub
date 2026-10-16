### Fixed

- Windows: opening terminals in quick succession could make a just-opened tab
  vanish while its shell was still starting. Layout changes are sent to the
  backend as a whole-layout seed followed by the change itself, and the WebView
  could deliver the larger seed after the change, so the stale seed overwrote the
  new tab. Layout and other projection intents now reach the backend in the order
  they were issued (#4826).
