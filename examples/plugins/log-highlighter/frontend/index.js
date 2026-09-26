// Log Highlighter — an example termiHub protocol-parser plugin.
//
// This file runs inside the frontend-plugin sandbox (a Web Worker: no DOM, no
// `window`, no Tauri IPC). The host wraps it so `termihub` is this plugin's own
// API instance. `transform` is called for every chunk of terminal output and
// must be fast and side-effect free: return the rewritten text, or `null` to
// pass the chunk through byte-exact (the cheap, common case).
//
// Caveat worth copying: output arrives in arbitrary chunks, so a token can be
// split across two chunks. A highlighter like this one simply misses such a
// token; a parser that must never miss one has to buffer across chunks per
// `sessionId` (see `onSessionStart` / `onSessionEnd`).

"use strict";

/* global termihub */ // provided by the sandbox

var RED = "\u001b[31m";
var YELLOW = "\u001b[33m";
var RESET = "\u001b[0m";

// Whole-word, upper-case log levels only, so "errors" or "Warning" are left alone.
var LEVELS = /\b(ERROR|WARN)\b/g;

termihub.registerProtocolParser({
  id: "log-highlighter",
  name: "Log Highlighter",
  transform: function (data) {
    // Fast path: most chunks contain neither token — leave them untouched.
    if (data.indexOf("ERROR") === -1 && data.indexOf("WARN") === -1) return null;
    var out = data.replace(LEVELS, function (level) {
      return (level === "ERROR" ? RED : YELLOW) + level + RESET;
    });
    return out === data ? null : out;
  },
});
