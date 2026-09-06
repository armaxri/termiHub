import { ensureValidNavigatorLocale } from "./locale";

// Runs on import so `navigator.language` is a valid BCP-47 tag before any module
// reads it at evaluation time. In particular `uplot` builds
// `new Intl.NumberFormat(navigator.language)` at module scope; on a `C`/`POSIX`
// locale that throws `RangeError: invalid language tag: C` and aborts the whole
// bundle before React mounts → blank app (#2646).
//
// This module MUST stay the FIRST import in `src/main.tsx` so it evaluates ahead
// of the application module graph (which statically pulls in `uplot`).
ensureValidNavigatorLocale();
