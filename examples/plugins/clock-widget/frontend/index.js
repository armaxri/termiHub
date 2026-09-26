// Clock Widget — an example termiHub status-bar-widget plugin.
//
// This file runs inside the frontend-plugin sandbox (a Web Worker: no DOM, no
// `window`, no Tauri IPC). The host wraps it so `termihub` is this plugin's own
// API instance. `render()` cannot return a live element — it returns a small
// declarative node (`{ tag, text, attrs, children }`) that the host builds into
// the status bar through a strict allowlist (no HTML, no event handlers).
//
// To update what is shown, register the widget again under the same `id`: the
// host replaces the previous node. `dispose()` runs when the plugin is disabled
// or uninstalled — always stop timers there.

"use strict";

/* global termihub, setInterval, clearInterval */ // provided by the sandbox

var WIDGET_ID = "clock-widget";
var timer = null;

function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

function currentTime() {
  var now = new Date();
  return pad(now.getHours()) + ":" + pad(now.getMinutes());
}

var widget = {
  id: WIDGET_ID,
  position: "right",
  render: function () {
    var time = currentTime();
    return {
      tag: "span",
      text: time,
      attrs: { title: "Local time", "aria-label": "Time " + time },
    };
  },
  dispose: function () {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },
};

termihub.registerStatusBarWidget(widget);

// Re-render every 30 s; re-registering the same id replaces the shown node.
timer = setInterval(function () {
  termihub.registerStatusBarWidget(widget);
}, 30000);
