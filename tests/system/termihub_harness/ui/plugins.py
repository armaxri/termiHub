"""Frontend-plugin baseline helpers (#2136).

``PluginsUi`` seeds a **real** frontend plugin onto disk in the suite app's
isolated config dir and drives the experimental frontend-plugin gate, so a
system test can prove — in a production-shaped build under the enforced CSP —
that an enabled frontend plugin actually *executes*: its protocol parser
transforms terminal output and its status-bar widget renders. This is the
regression baseline the plugin-sandbox work (#2136) needs before frontend
plugin execution is moved into a least-privilege sandbox and ``blob:`` is
dropped from ``script-src``.

Why disk-seeding rather than the install UI: the plugin manager scans
``<config>/plugins/<id>/`` for a directory with a valid ``manifest.json`` and
derives each plugin's enabled/active state from ``plugin-state.json`` at that
root (``core/src/plugin/manager.rs``). Signing/trust gates only the *package
install* path, not the directory scan — so writing the plugin files directly is
a faithful stand-in for an installed plugin, without needing a signed
``.termihub-plugin`` package. The write runs in the restart down-window (the
only time the config tree is unheld), mirroring
:class:`~termihub_harness.ui.ConfigRecoveryUi`.

The fixture declares **both** a protocol parser and a status-bar widget from one
``frontend/index.js`` entry point (deduped to a single injected script). The
parser rewrites a sentinel token so a transformed line is unmistakable; the
widget renders a span the status bar mounts under a stable ``data-testid``.

Combine with :class:`~termihub_harness.SystemTest` (config dir + restart),
:class:`~termihub_harness.ui.SettingsUi` (category navigation), and
:class:`~termihub_harness.ui.TerminalUi` (to exercise the parser).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from ..bridge import BridgeError
from .base import HarnessMixin

#: Id of the seeded fixture plugin (also its install directory name).
SANDBOX_PLUGIN_ID = "termihub-sandbox-probe"
#: Widget id the fixture registers; the status bar mounts it as
#: ``plugin-widget-<id>`` (see ``PluginStatusBarWidgets.tsx``).
SANDBOX_WIDGET_ID = "sandbox-probe"
#: The ``data-testid`` the seeded widget renders under, once its ``render()`` runs.
SANDBOX_WIDGET_TESTID = f"plugin-widget-{SANDBOX_WIDGET_ID}"
#: Sentinel the fixture parser rewrites (input → output). Distinct tokens so a
#: transformed line cannot be confused with an untransformed one.
PARSER_INPUT_TOKEN = "sbxparsersrc"
PARSER_OUTPUT_TOKEN = "sbxparserhit"

#: The ``data-testid`` on the experimental frontend-plugin gate toggle
#: (``FrontendPluginGateSettings.tsx``), under the *plugins* settings category.
GATE_TOGGLE_TESTID = "settings-frontend-plugins-enabled"
#: Store path of the gate setting (default-off; absent from the store until set).
GATE_STATE_PATH = "settings.frontendPluginsEnabled"

#: The fixture's ``manifest.json`` (camelCase; ``deny_unknown_fields`` on the Rust
#: side, so only known fields). ``apiVersion`` matches
#: ``CURRENT_PLUGIN_API_VERSION`` so the plugin resolves as compatible; all three
#: platforms are declared so the fixture activates on any CI leg.
_MANIFEST = {
    "id": SANDBOX_PLUGIN_ID,
    "name": "Sandbox Probe",
    "version": "1.0.0",
    "author": "termiHub system tests",
    "description": (
        "Fixture plugin: a protocol parser + status-bar widget used to baseline "
        "frontend-plugin execution under the enforced CSP (#2136)."
    ),
    "license": "MIT",
    "apiVersion": "1.0",
    "platforms": ["windows", "linux", "macos"],
    "permissions": ["terminal", "ui"],
    "extensions": {
        "protocolParser": {
            "name": "Sandbox Probe Parser",
            "description": "Rewrites a sentinel token so the test can prove the parser ran.",
            "entryPoint": "frontend/index.js",
        },
        "statusBarWidget": {
            "entryPoint": "frontend/index.js",
            "position": "right",
        },
    },
}

#: The fixture's ``frontend/index.js``. The loader wraps this source in
#: ``(function (termihub) { … })(<per-plugin api>)`` (``frontendPlugins.ts``), so
#: ``termihub`` here is this plugin's own API instance. The parser replaces every
#: PARSER_INPUT_TOKEN with PARSER_OUTPUT_TOKEN (returning ``null`` — pass-through —
#: for chunks that do not contain it, the fast path). The widget renders a plain
#: span; it touches only the DOM node it creates and never reaches for IPC.
_FRONTEND_JS = f"""\
termihub.registerProtocolParser({{
  id: "sandbox-probe-parser",
  name: "Sandbox Probe Parser",
  transform: function (data) {{
    if (data.indexOf("{PARSER_INPUT_TOKEN}") === -1) return null;
    return data.split("{PARSER_INPUT_TOKEN}").join("{PARSER_OUTPUT_TOKEN}");
  }},
}});

termihub.registerStatusBarWidget({{
  id: "{SANDBOX_WIDGET_ID}",
  position: "right",
  render: function () {{
    var el = document.createElement("span");
    el.textContent = "sandbox-probe-ok";
    return el;
  }},
  dispose: function () {{}},
}});
"""


class PluginsUi(HarnessMixin):
    """Seed a frontend plugin on disk and drive the experimental frontend gate."""

    if TYPE_CHECKING:  # supplied by the classes this mixin is combined with

        @property
        def config_dir(self) -> Path: ...

        def restart_app(self, between: Callable[[], None] | None = None) -> None: ...

        # from SettingsUi
        def open_settings_category(self, category: str) -> None: ...

    SANDBOX_PLUGIN_ID = SANDBOX_PLUGIN_ID
    SANDBOX_WIDGET_TESTID = SANDBOX_WIDGET_TESTID
    PARSER_INPUT_TOKEN = PARSER_INPUT_TOKEN
    PARSER_OUTPUT_TOKEN = PARSER_OUTPUT_TOKEN

    # ── on-disk seeding ──────────────────────────────────────────────────────
    def plugins_root(self) -> Path:
        """The ``<config>/plugins`` root the plugin manager scans."""
        return self.config_dir / "plugins"

    def write_sandbox_plugin(self) -> None:
        """Write the fixture plugin's files into the suite app's config dir.

        Lays out ``plugins/<id>/manifest.json`` + ``plugins/<id>/frontend/index.js``
        and marks the plugin **enabled** in ``plugins/plugin-state.json`` (the flag
        the manager reads to load and activate it on startup). Intended to run in
        the restart down-window via :meth:`seed_sandbox_plugin`.
        """
        plugin_dir = self.plugins_root() / SANDBOX_PLUGIN_ID
        (plugin_dir / "frontend").mkdir(parents=True, exist_ok=True)
        (plugin_dir / "manifest.json").write_text(
            json.dumps(_MANIFEST, indent=2), encoding="utf-8"
        )
        (plugin_dir / "frontend" / "index.js").write_text(_FRONTEND_JS, encoding="utf-8")
        # Persist the enabled flag explicitly so activation does not rely on the
        # manager's "no record → enabled" default.
        state = {"plugins": {SANDBOX_PLUGIN_ID: {"enabled": True, "installedAt": 1_700_000_000_000}}}
        (self.plugins_root() / "plugin-state.json").write_text(
            json.dumps(state, indent=2), encoding="utf-8"
        )

    def seed_sandbox_plugin(self) -> None:
        """Restart the app with the fixture plugin seeded on disk.

        The write runs while the app is down, so the relaunch scans the plugins
        root, loads the enabled+compatible frontend plugin, and (post-#2234)
        promotes it to ``active``. The frontend-plugin gate is still off, so no
        plugin JS executes yet — :meth:`enable_frontend_plugin_gate` does that.
        """
        self.restart_app(between=self.write_sandbox_plugin)

    def sandbox_plugin_state(self) -> str | None:
        """The seeded plugin's runtime state from the store, or ``None`` if absent."""
        plugins = self.driver.get_state("plugins")
        if not isinstance(plugins, list):
            return None
        for plugin in plugins:
            manifest = plugin.get("manifest") if isinstance(plugin, dict) else None
            if isinstance(manifest, dict) and manifest.get("id") == SANDBOX_PLUGIN_ID:
                return plugin.get("state")
        return None

    # ── the experimental frontend-plugin gate ────────────────────────────────
    def frontend_plugin_gate_enabled(self) -> bool:
        """Whether the experimental frontend-plugin gate is on.

        The setting is absent from the store until first set, so a missing path
        (``BridgeError``) means "off" — mirroring ``SettingsUi._experimental_enabled``.
        """
        try:
            return bool(self.driver.get_state(GATE_STATE_PATH))
        except BridgeError:
            return False

    def _set_frontend_plugin_gate(self, enabled: bool) -> None:
        self.open_settings_category("plugins")
        self.wait(
            lambda: self.driver.exists(GATE_TOGGLE_TESTID),
            what="the frontend-plugin gate toggle",
        )
        if self.frontend_plugin_gate_enabled() != enabled:
            self.driver.click(GATE_TOGGLE_TESTID)
        self.wait(
            lambda: self.frontend_plugin_gate_enabled() == enabled,
            what=f"the frontend-plugin gate to be {'on' if enabled else 'off'}",
        )

    def enable_frontend_plugin_gate(self) -> None:
        """Turn the experimental frontend-plugin gate on via the Settings UI.

        Flipping the gate re-runs ``loadPlugins`` → ``reconcileFrontendPlugins``,
        which injects each active frontend plugin's JS — the real user action that
        starts frontend plugin execution.
        """
        self._set_frontend_plugin_gate(True)

    def disable_frontend_plugin_gate(self) -> None:
        """Turn the gate off; injected plugin scripts are torn down live."""
        self._set_frontend_plugin_gate(False)
