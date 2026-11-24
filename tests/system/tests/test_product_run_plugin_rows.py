"""Product run: the plugin row's dot and type icon say what they mean (#5931).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` (R-133) found the Plugins sidebar row with an unlabelled
sliders icon and a green dot with no meaning given, and the status bar's plugin
item reading ``1 · 1``. Now the dot names its state (Enabled, Disabled, Error)
and the type icon names the plugin's type (a protocol parser shows the binary
icon, not the sliders that read as settings), each in a tooltip and as its
accessible name. The status bar item reads "1 plugin" and its tooltip adds the
enabled count and that a click opens the plugin list.

One fresh profile with the fixture plugin seeded (it restarts the app).

The ``test_grade_*`` functions grade fixed inputs without an app and run in the
normal lane.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import PluginsUi, SettingsUi, SidebarUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.plugin_rows import (
    plugin_row_label_problems,
    plugins_indicator_problems,
)

GOOD_LABEL = "1 plugin installed, 1 enabled — click to open the plugin list"


# ── app-free grade tests ──────────────────────────────────────────────────
def _row(dot="Enabled", dot_title=None, icon="Protocol parser", icon_title=None):
    return plugin_row_label_problems(
        "row",
        dot_label=dot,
        dot_title=dot if dot_title is None else dot_title,
        icon_label=icon,
        icon_title=icon if icon_title is None else icon_title,
    )


def test_grade_labelled_row_passes():
    assert _row() == []
    assert _row(dot="Disabled", icon="Terminal backend") == []
    assert _row(dot="Error", icon="Plugin") == []


def test_grade_unlabelled_dot_fails():
    problems = plugin_row_label_problems(
        "row", dot_label=None, dot_title=None, icon_label="Theme", icon_title="Theme"
    )
    assert problems == ["row: the status dot has no accessible name"]


def test_grade_dot_without_tooltip_fails():
    assert _row(dot_title="") == ["row: the dot's tooltip '' differs from 'Enabled'"]


def test_grade_unknown_dot_word_fails():
    assert _row(dot="Active") == ["row: the status dot reads 'Active', not a known state"]


def test_grade_unlabelled_icon_fails():
    problems = plugin_row_label_problems(
        "row", dot_label="Enabled", dot_title="Enabled", icon_label=None, icon_title=None
    )
    assert problems == ["row: the type icon has no accessible name"]


def test_grade_settings_named_icon_fails():
    problems = _row(icon="Settings")
    assert problems == ["row: the type icon reads 'Settings', not a plugin type"]


def test_grade_icon_without_tooltip_fails():
    problems = _row(icon_title="")
    assert problems == ["row: the icon's tooltip '' differs from 'Protocol parser'"]


def test_grade_indicator_in_words_passes():
    assert plugins_indicator_problems(text="1 plugin", label=GOOD_LABEL, installed=1) == []
    label = "3 plugins installed, 2 enabled — click to open the plugin list"
    assert plugins_indicator_problems(text="3 plugins", label=label, installed=3) == []


def test_grade_cryptic_indicator_fails():
    problems = plugins_indicator_problems(text="1 · 1", label="1 · 1", installed=1)
    assert "the plugin item reads '1 · 1', not 'N plugin(s)'" in problems
    assert any("enabled count" in p for p in problems)
    assert any("what a click does" in p for p in problems)


def test_grade_indicator_wrong_count_or_plural_fails():
    label = "2 plugins installed, 1 enabled — click to open the plugin list"
    assert plugins_indicator_problems(text="2 plugins", label=label, installed=3) == [
        "the plugin item counts 2, but 3 are installed"
    ]
    assert plugins_indicator_problems(
        text="1 plugins",
        label="1 plugins installed, 1 enabled — click to open the plugin list",
        installed=1,
    ) == ["the plugin item reads '1 plugins': wrong plural"]


def test_grade_indicator_label_must_start_with_text():
    problems = plugins_indicator_problems(
        text="1 plugin", label="Plugins: 1 enabled — click to open the plugin list", installed=1
    )
    assert problems == [
        "the plugin item's name 'Plugins: 1 enabled — click to open the plugin list' "
        "does not start with '1 plugin'"
    ]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX paths")
class TestProductRunPluginRows(ProductRunUi, PluginsUi, SettingsUi, SidebarUi, SystemTest):
    phase = "Plugin row labels"
    request_timeout = 90.0

    def test_10_plugin_row_labels(self):
        with self.step(
            "plugin-rows.labels",
            "The plugin row's dot and type icon name what they mean on hover and to a "
            "screen reader",
            expect="the Plugins sidebar: 'Sandbox Probe' with a green dot and a binary (0/1) "
            "icon, not sliders; hovering the dot shows 'Enabled', hovering the icon shows "
            "'Protocol parser' (#5931)",
        ):
            self.seed_sandbox_plugin()
            self.wait(lambda: self.sandbox_plugin_state() is not None, what="the seeded plugin")
            self._ensure_sidebar("plugins", "activity-bar-plugins")
            pid = self.SANDBOX_PLUGIN_ID
            self.wait(lambda: self.driver.exists(f"plugin-row-{pid}"), what="the plugin row")
            dot = f"plugin-state-dot-{pid}"
            icon = f"plugin-type-icon-{pid}"
            dot_label = self.driver.get_attribute(dot, "aria-label")
            dot_title = self.driver.get_attribute(dot, "title")
            icon_label = self.driver.get_attribute(icon, "aria-label")
            icon_title = self.driver.get_attribute(icon, "title")
            self.evidence(
                f"plugin {pid}: dot {dot_label!r} (title {dot_title!r}); "
                f"icon {icon_label!r} (title {icon_title!r})"
            )
            problems = plugin_row_label_problems(
                "plugin row",
                dot_label=dot_label,
                dot_title=dot_title,
                icon_label=icon_label,
                icon_title=icon_title,
            )
            assert not problems, problems
            assert icon_label == "Protocol parser", f"the fixture's icon reads {icon_label!r}"
            self.shot(label="plugin-row")

    def test_20_status_bar_plugin_item(self):
        with self.step(
            "plugin-rows.status-bar",
            "The status bar's plugin item reads '1 plugin' in words",
            expect="the status bar's left side: a puzzle icon and '1 plugin' (not '1 · 1'); "
            "hovering it shows '1 plugin installed, 1 enabled — click to open the plugin "
            "list' (#5931)",
        ):
            self.require("plugin-rows.labels")
            item = "plugins-indicator"
            self.wait(lambda: self.driver.exists(item), what="the status bar plugin item")
            plugins = self.driver.get_state("plugins") or []
            text = self.driver.get_text(item)
            label = self.driver.get_attribute(item, "aria-label")
            self.evidence(f"status bar plugin item: {text!r} (name {label!r})")
            problems = plugins_indicator_problems(
                text=text, label=label, installed=len(plugins)
            )
            assert not problems, problems
            self.shot(label="status-bar")
