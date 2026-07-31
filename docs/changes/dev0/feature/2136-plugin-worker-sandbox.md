### Changed

- Frontend (JavaScript) plugins — experimental, default-off
  (`frontendPluginsEnabled`) — now execute inside a **least-privilege Web Worker
  sandbox** instead of being injected as `<script>` into the main WebView
  document. Plugin code no longer has access to `window`, the DOM, or Tauri IPC:
  protocol parsers run over terminal output through an ordered asynchronous
  message pipeline (the no-plugin fast path stays fully synchronous and
  byte-exact), and status-bar widgets are described declaratively and rendered by
  the host on the main thread. This closes the weak-isolation gap in the original
  restrictive-CSP work (part of #2136). Dropping `blob:` from `script-src`
  remains a follow-up.
  </content>
  </invoke>
