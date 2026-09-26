### Added

- Network tools now keep a run history (PROD-032, #3456). Every finished ping,
  traceroute, port scan, ping sweep, DNS lookup, open-ports listing and
  Wake-on-LAN send is recorded — with its parameters, where it ran (this
  computer or an agent), start/end time, status, a one-line summary and its
  results — so results survive re-runs, closing the panel and restarting the
  app. Each tool panel has a collapsible **History** section: open a past run
  read-only, re-run it with the same parameters, delete it, clear the tool's
  history, or export runs as JSON (a single run also as CSV).
- History is bounded (the newest 50 runs per tool, for up to 30 days, with
  large result tables trimmed per run) and stored only on this computer in
  `network-tool-history.json` — results can contain hostnames and IP
  addresses. **Settings → Sessions → Network Tool History** turns recording off
  and clears the history for every tool.

### Changed

- The Wake-on-LAN panel's session-only "History" list is replaced by the
  persisted run history.
