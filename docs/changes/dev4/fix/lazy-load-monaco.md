### Changed

- The Monaco-based file editor and its syntax-highlighting engine (Monaco + Shiki)
  are now code-split out of the main app bundle and loaded on demand — only the
  first time a file editor or the Editor settings category is actually opened.
  Previously they were downloaded, parsed and evaluated at startup for every
  session, including terminal-only sessions that never open a file. This roughly
  halves the eager startup bundle (~8.5 MB → ~4.4 MB raw; ~2.15 MB → ~1.08 MB
  gzipped), improving cold-start time to interactive (PERF-001).
