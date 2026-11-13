"""Product run: Solarized selected row, success colour and form controls (#5639).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run 20261113T080834Z found, in the
Solarized themes:

- R-053: the selected sidebar row was base2 on the base3 sidebar (~1.1:1), so
  only the thin left bar showed the selection;
- R-060: "connected" / success painted Solarized's olive green, ~23° of hue
  from the warning yellow, so it read as "connecting";
- R-061: Solarized Light placeholders were nearly as dark as entered text and
  the off toggle drew a dark knob that read as "on".

These grades read what the WebView resolved: the selected row's rendered
background against the sidebar, the selection bar against both, the success
and warning hues per Solarized theme, and the placeholder / off-toggle tokens.
"""

from __future__ import annotations

import colorsys
import re
import sys

import pytest

from termihub_harness import ConnectionsUi, SettingsUi, SidebarUi, SystemTest, unique_name
from termihub_harness.colors import Rgba, contrast, parse_color, relative_luminance
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.lookups import connection_item_testid
from termihub_harness.ui.theme import ThemeUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's shell is POSIX-only"),
]

#: The selected row must read as a band, not a hint (was 1.14:1).
MIN_SELECTED_ROW_DELTA = 1.4
#: WCAG 2.2 SC 1.4.11 for the selection bar and the off toggle.
UI_COMPONENT_MIN = 3.0
AA_TEXT = 4.5
#: Success and warning hues must be this far apart (was ~23°).
MIN_SUCCESS_WARNING_HUE = 45.0
SOLARIZED_THEMES = ("solarized-light", "solarized-dark")


def hue_degrees(color: Rgba) -> float:
    """HSL hue of an opaque colour, in degrees."""
    h, _, _ = colorsys.rgb_to_hls(color.r / 255, color.g / 255, color.b / 255)
    return h * 360


def hue_distance(a: Rgba, b: Rgba) -> float:
    d = abs(hue_degrees(a) - hue_degrees(b))
    return min(d, 360 - d)


class TestProductRunSolarized(ProductRunUi, ThemeUi, SettingsUi, SidebarUi, ConnectionsUi, SystemTest):
    phase = "Solarized states"
    request_timeout = 90.0

    def _token(self, name: str) -> Rgba:
        """A ``:root`` token, following one ``var(--x)`` indirection."""
        value = self.driver.get_computed_style(name).strip()
        match = re.match(r"var\((--[\w-]+)\)", value)
        return self.root_color(match.group(1)) if match else parse_color(value)

    def _settled_background(self, testid: str) -> Rgba:
        """The element's background once its colour transition has finished."""
        seen: list[str] = []

        def stable() -> str | None:
            seen.append(self.driver.get_computed_style("background-color", testid))
            return seen[-1] if len(seen) >= 3 and seen[-1] == seen[-2] == seen[-3] else None

        return parse_color(self.wait(stable, what="the row background to settle", interval=0.2))

    def test_10_selected_row_reads_as_selected(self):
        name = f"Solarized row {unique_name('sel').split('-')[-1]}"
        with self.step(
            "solarized.selected-row-contrast",
            "Solarized Light: the selected row is a visible band with a 3:1 bar (#5639)",
            expect="Solarized Light with one connection row selected: a darker beige band "
            "with a blue left bar",
        ):
            self.set_theme("solarized-light")
            self.switch_to_connections_sidebar()
            self.create_local_connection(name)
            item = connection_item_testid(self.require_connection(name)["id"])
            self.driver.click(item)
            self.wait(
                lambda: "--selected" in (self.driver.get_attribute(item, "class") or ""),
                what="the row to be selected",
            )
            sidebar = self._token("--sidebar-bg")
            row = self._settled_background(item)
            bar = self._token("--selected-row-indicator")
            delta = contrast(row, sidebar)
            self.evidence(
                f"row {row.hex()} on sidebar {sidebar.hex()} = {delta:.2f}:1; "
                f"bar {bar.hex()} = {contrast(bar, sidebar):.2f}:1 / {contrast(bar, row):.2f}:1"
            )
            assert delta >= MIN_SELECTED_ROW_DELTA, f"selected row only {delta:.2f}:1"
            assert contrast(bar, sidebar) >= UI_COMPONENT_MIN, "bar < 3:1 on the sidebar"
            assert contrast(bar, row) >= UI_COMPONENT_MIN, "bar < 3:1 on the row"

    def test_20_success_is_not_warning(self):
        for theme in SOLARIZED_THEMES:
            with self.step(
                f"themes.{theme}.success-hue",
                f"{theme}: success / connected read as green, not as warning (#5639)",
                expect=f"the app in {theme}",
            ):
                self.set_theme(theme)
                pairs = {
                    "text": (self._token("--color-success"), self._token("--color-warning")),
                    "dot": (self._token("--state-connected"), self._token("--state-connecting")),
                }
                for role, (ok, warn) in pairs.items():
                    d = hue_distance(ok, warn)
                    self.evidence(f"{role}: success {ok.hex()} vs warning {warn.hex()} = {d:.0f}°")
                    assert d >= MIN_SUCCESS_WARNING_HUE, f"{role} success only {d:.0f}° from warning"

    def test_30_placeholder_and_off_toggle(self):
        with self.step(
            "themes.solarized-light.controls",
            "Solarized Light: placeholders lighter than text; off toggle has a light knob (#5639)",
            expect="the app in Solarized Light",
        ):
            self.set_theme("solarized-light")
            field = self._token("--bg-input")
            text = self._token("--text-primary")
            placeholder = self._token("--input-placeholder")
            track = self._token("--toggle-off-track")
            knob = self._token("--toggle-off-thumb")
            self.evidence(
                f"placeholder {placeholder.hex()} {contrast(placeholder, field):.2f}:1, "
                f"text {text.hex()} {contrast(text, field):.2f}:1; "
                f"off knob {knob.hex()} on track {track.hex()} {contrast(knob, track):.2f}:1"
            )
            assert contrast(placeholder, field) >= AA_TEXT, "placeholder below AA"
            assert contrast(text, field) >= 2 * contrast(placeholder, field), (
                "placeholder is not clearly lighter than entered text"
            )
            assert relative_luminance(knob) > relative_luminance(track), "off knob is dark"
            assert contrast(knob, track) >= UI_COMPONENT_MIN, "off knob < 3:1 on its track"
