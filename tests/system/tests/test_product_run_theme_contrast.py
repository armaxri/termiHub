"""Product run: selected rows, activity bar, links and switches per theme (#5853, #5888).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found:

- R-059: the Solarized Light selected row was a beige band at 1.44:1 on the
  cream sidebar; only the left bar marked it;
- R-115: Light's hint and empty-state body text read weak on the sidebar;
- R-144: Solarized Light's dark teal activity bar pulled the eye from the cream
  sidebar and editor;
- R-145: Solarized Dark links sat at exactly 4.50:1;
- R-146: the Solarized Light off knob was 4.13:1 on its track, and on/off
  differed mainly by colour;
- #5888: Dark and Light marked a selected row only with an accent tint near
  1.2:1 on the sidebar, with no bar or outline.

Now an opaque selected row carries a 1px outline at >=3:1 against the sidebar,
a tinted one (Dark, Light) an accent left bar at >=3:1 on the sidebar and row,
Light's secondary text reaches 5.8:1 on the sidebar, Solarized activity bars sit
on the theme's own light/dark side, links reach 5:1 on every text surface, and
the on knob draws a check glyph (the off knob reaches 4.5:1 in Solarized Light).

The live steps read what the WebView resolved for those tokens. The
``test_grade_*`` functions grade fixed colours without an app and run in the
normal lane.
"""

from __future__ import annotations

import re
import sys

import pytest

from termihub_harness import ConnectionsUi, SettingsUi, SidebarUi, SystemTest, unique_name
from termihub_harness.colors import Rgba, composite, contrast, parse_color, relative_luminance
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.lookups import connection_item_testid
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

#: WCAG 2.2 SC 1.4.11: UI components, state indicators and boundaries.
UI_COMPONENT_MIN = 3.0
#: Links are thin 12-13px underlined text: a margin over AA (R-145).
LINK_MIN = 5.0
#: Light's hint / empty-state body text on the sidebar (R-115).
LIGHT_HINT_MIN = 5.8
#: The surfaces links sit on.
LINK_SURFACES = ("--bg-primary", "--bg-secondary", "--sidebar-bg", "--bg-dropdown")
SOLARIZED_THEMES = ("solarized-light", "solarized-dark")


# ── grading ───────────────────────────────────────────────────────────────
def _is_light(color: Rgba) -> bool:
    return relative_luminance(color) > 0.5


def selected_row_problems(sidebar: Rgba, row: Rgba, outline: Rgba, bar: Rgba) -> list[str]:
    """The selected row needs a >=3:1 boundary (its fill or a 1px outline) and bar."""
    problems = []
    fill = contrast(row, sidebar)
    edge = contrast(outline, sidebar) if outline.a > 0.99 else 1.0
    if max(fill, edge) < UI_COMPONENT_MIN:
        problems.append(
            f"selected row boundary only {max(fill, edge):.2f}:1 on the sidebar "
            f"(fill {fill:.2f}:1, outline {edge:.2f}:1)"
        )
    if contrast(bar, sidebar) < UI_COMPONENT_MIN:
        problems.append(f"selection bar only {contrast(bar, sidebar):.2f}:1 on the sidebar")
    return problems


def tinted_row_problems(sidebar: Rgba, row: Rgba, bar: Rgba) -> list[str]:
    """A translucent tint row is a faint band: its bar must reach 3:1 on both sides (#5888)."""
    band = composite(row, sidebar)
    problems = []
    if not bar.opaque:
        problems.append("selection bar is not drawn; the row is marked by its tint alone")
        return problems
    for where, under in (("sidebar", sidebar), ("selected row", band)):
        if contrast(bar, under) < UI_COMPONENT_MIN:
            problems.append(f"selection bar only {contrast(bar, under):.2f}:1 on the {where}")
    return problems


def row_problems(sidebar: Rgba, row: Rgba, outline: Rgba, bar: Rgba) -> list[str]:
    """Grade an opaque row by its boundary, a translucent (tint) row by its bar."""
    if row.opaque:
        return selected_row_problems(sidebar, row, outline, bar)
    return tinted_row_problems(sidebar, row, bar)


def link_problems(link: Rgba, surfaces: dict[str, Rgba]) -> list[str]:
    """Each surface the link colour misses 5:1 on."""
    return [
        f"link {link.hex()} on {name} {bg.hex()} only {contrast(link, bg):.2f}:1"
        for name, bg in surfaces.items()
        if contrast(link, bg) < LINK_MIN
    ]


def hint_problems(secondary: Rgba, muted: Rgba, sidebar: Rgba) -> list[str]:
    """Light: hint text reaches 5.8:1 on the sidebar; muted stays the lighter level."""
    problems = []
    if contrast(secondary, sidebar) < LIGHT_HINT_MIN:
        problems.append(f"secondary text only {contrast(secondary, sidebar):.2f}:1 on the sidebar")
    if contrast(muted, sidebar) >= contrast(secondary, sidebar):
        problems.append("muted text is not lighter than secondary text")
    return problems


def activity_bar_problems(
    bar: Rgba, sidebar: Rgba, inactive: Rgba, active: Rgba, indicator: Rgba
) -> list[str]:
    """The bar sits on the sidebar's light/dark side; icons and indicator reach 3:1."""
    problems = []
    if _is_light(bar) != _is_light(sidebar):
        side = "light" if _is_light(sidebar) else "dark"
        problems.append(f"activity bar {bar.hex()} is not on the {side} side like the sidebar")
    for name, fg in (("inactive icon", inactive), ("active icon", active), ("indicator", indicator)):
        if contrast(fg, bar) < UI_COMPONENT_MIN:
            problems.append(f"{name} {fg.hex()} only {contrast(fg, bar):.2f}:1 on the bar")
    return problems


def toggle_problems(off_knob: Rgba, off_track: Rgba, on_knob: Rgba, on_track: Rgba) -> list[str]:
    """Both knobs reach 3:1 on their tracks; the on glyph (track colour) 3:1 on the knob."""
    problems = []
    if contrast(off_knob, off_track) < UI_COMPONENT_MIN:
        problems.append(f"off knob only {contrast(off_knob, off_track):.2f}:1 on its track")
    if contrast(on_knob, on_track) < UI_COMPONENT_MIN:
        problems.append(
            f"on knob / check glyph only {contrast(on_knob, on_track):.2f}:1 on the accent"
        )
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
BASE3 = parse_color("#fdf6e3")
BASE2 = parse_color("#eee8d5")
BEIGE = parse_color("#d5cfbd")
BLUE = parse_color("#1f6fa6")
NONE = parse_color("transparent")


def test_grade_beige_row_without_outline_fails():
    problems = selected_row_problems(BASE3, BEIGE, NONE, BLUE)
    assert len(problems) == 1 and "boundary only 1.44:1" in problems[0]


def test_grade_outlined_row_passes():
    assert selected_row_problems(BASE3, BEIGE, parse_color("#586e75"), BLUE) == []


def test_grade_faint_bar_is_named():
    problems = selected_row_problems(BASE3, BEIGE, parse_color("#586e75"), parse_color("#93a1a1"))
    assert problems == ["selection bar only 2.48:1 on the sidebar"]


DARK_SIDEBAR = parse_color("#161b24")
DARK_ACCENT = parse_color("#2d72e6")
LIGHT_SIDEBAR = parse_color("#f3f3f3")
LIGHT_ACCENT = parse_color("#0366d6")


def _tint(accent: Rgba, alpha: float = 0.18) -> Rgba:
    """``color-mix(in srgb, accent 18%, transparent)``, as the WebView computes it."""
    return Rgba(accent.r, accent.g, accent.b, alpha)


def test_grade_tint_row_without_bar_fails():
    problems = row_problems(DARK_SIDEBAR, _tint(DARK_ACCENT), NONE, NONE)
    assert problems == ["selection bar is not drawn; the row is marked by its tint alone"]


def test_grade_tint_row_with_accent_bar_passes():
    for sidebar, accent in ((DARK_SIDEBAR, DARK_ACCENT), (LIGHT_SIDEBAR, LIGHT_ACCENT)):
        for alpha in (0.18, 0.10):  # resting and hovered tints
            assert row_problems(sidebar, _tint(accent, alpha), NONE, accent) == []


def test_grade_tint_row_with_faint_bar_is_named():
    problems = row_problems(LIGHT_SIDEBAR, _tint(LIGHT_ACCENT), NONE, parse_color("#79b8ff"))
    assert len(problems) == 2
    assert "on the sidebar" in problems[0] and "on the selected row" in problems[1]


def test_grade_opaque_row_still_needs_a_boundary():
    problems = row_problems(BASE3, BEIGE, NONE, BLUE)
    assert len(problems) == 1 and "boundary only 1.44:1" in problems[0]


def test_grade_link_at_the_aa_edge_fails():
    surfaces = {"--sidebar-bg": parse_color("#073642"), "--bg-primary": parse_color("#002b36")}
    problems = link_problems(parse_color("#4b9fda"), surfaces)
    assert len(problems) == 1 and "--sidebar-bg" in problems[0]
    assert link_problems(parse_color("#5ca8dd"), surfaces) == []


def test_grade_light_hints():
    sidebar = parse_color("#f3f3f3")
    assert hint_problems(parse_color("#545b64"), parse_color("#686d74"), sidebar) == []
    old = hint_problems(parse_color("#5e6670"), parse_color("#686d74"), sidebar)
    assert len(old) == 1 and "5.24:1" in old[0]
    flat = hint_problems(parse_color("#545b64"), parse_color("#545b64"), sidebar)
    assert flat == ["muted text is not lighter than secondary text"]


def test_grade_dark_activity_bar_beside_light_sidebar_fails():
    teal = parse_color("#073642")
    problems = activity_bar_problems(
        teal, BASE3, parse_color("#677d85"), BASE2, parse_color("#268bd2")
    )
    assert len(problems) == 1 and "not on the light side" in problems[0]


def test_grade_light_activity_bar_passes():
    problems = activity_bar_problems(
        BASE2, BASE3, parse_color("#657b83"), parse_color("#002b36"), BLUE
    )
    assert problems == []


def test_grade_toggles():
    white = parse_color("#ffffff")
    assert toggle_problems(BASE3, parse_color("#586e75"), white, BLUE) == []
    weak = toggle_problems(BASE3, parse_color("#93a1a1"), white, parse_color("#6db0ff"))
    assert len(weak) == 2


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's shell is POSIX-only")
class TestProductRunThemeContrast(
    ProductRunUi, ThemeUi, SettingsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Theme contrast"
    request_timeout = 90.0

    def _token(self, name: str) -> Rgba:
        """A ``:root`` token, following one ``var(--x)`` indirection."""
        value = self.driver.get_computed_style(name).strip()
        match = re.match(r"var\((--[\w-]+)\)", value)
        return self.root_color(match.group(1)) if match else parse_color(value)

    def test_10_selected_row_has_a_boundary(self):
        name = f"Contrast row {unique_name('sel').split('-')[-1]}"
        self.switch_to_connections_sidebar()
        self.create_local_connection(name)
        item = connection_item_testid(self.require_connection(name)["id"])
        for theme in BUILTIN_THEMES:
            tinted = theme not in SOLARIZED_THEMES
            with self.step(
                f"themes.{theme}.selected-row-boundary",
                f"{theme}: the selected row has a >=3:1 cue on the sidebar (#5853 R-059, #5888)",
                expect=f"{theme} with one connection row selected: "
                + (
                    "an accent-tinted band with an accent left bar, easy to spot at a glance"
                    if tinted
                    else "an outlined band with a blue left bar, easy to spot at a glance"
                ),
            ):
                self.set_theme(theme)
                self.switch_to_connections_sidebar()
                self.driver.click(item)
                self.wait(
                    lambda: "--selected" in (self.driver.get_attribute(item, "class") or ""),
                    what="the row to be selected",
                )
                sidebar = self._token("--sidebar-bg")
                # The painted row, not the token: a tint resolves to a translucent colour.
                row = self.style_color("background-color", item)
                outline = self._token("--selected-row-outline")
                bar = self._token("--selected-row-indicator")
                band = composite(row, sidebar)
                self.evidence(
                    f"row {band.hex()} {contrast(band, sidebar):.2f}:1, outline {outline.hex()} "
                    f"{contrast(outline, sidebar):.2f}:1, bar {bar.hex()} "
                    f"{contrast(bar, sidebar):.2f}:1 on sidebar {sidebar.hex()}, "
                    f"{contrast(bar, band):.2f}:1 on the row"
                )
                problems = row_problems(sidebar, row, outline, bar)
                assert not problems, problems

    def test_20_links_and_hints(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}.link-contrast",
                f"{theme}: links reach 5:1 on every text surface (#5853 R-145)",
                expect=f"the app in {theme}; underlined links read clearly",
            ):
                self.set_theme(theme)
                link = self._token("--text-link")
                surfaces = {s: self._token(s) for s in LINK_SURFACES}
                for s, bg in surfaces.items():
                    self.evidence(f"--text-link {link.hex()} on {s} {bg.hex()} = {contrast(link, bg):.2f}:1")
                problems = link_problems(link, surfaces)
                assert not problems, problems
        with self.step(
            "themes.light.hint-text",
            "Light: hints and empty-state body text reach 5.8:1 on the sidebar (#5853 R-115)",
            expect="the app in Light; sidebar hints read as clearly as in the other themes",
        ):
            self.set_theme("light")
            self.switch_to_connections_sidebar()
            sidebar = self._token("--sidebar-bg")
            secondary = self._token("--text-secondary")
            muted = self._token("--text-muted")
            self.evidence(
                f"secondary {secondary.hex()} {contrast(secondary, sidebar):.2f}:1, muted "
                f"{muted.hex()} {contrast(muted, sidebar):.2f}:1 on sidebar {sidebar.hex()}"
            )
            problems = hint_problems(secondary, muted, sidebar)
            assert not problems, problems

    def test_30_activity_bar_matches_the_theme(self):
        for theme in SOLARIZED_THEMES:
            with self.step(
                f"themes.{theme}.activity-bar",
                f"{theme}: the activity bar sits on the theme's light/dark side (#5853 R-144)",
                expect=f"the app in {theme}; the icon column blends with the sidebar",
            ):
                self.set_theme(theme)
                bar = self._token("--activity-bar-bg")
                sidebar = self._token("--sidebar-bg")
                inactive = self._token("--activity-bar-inactive")
                active = self._token("--activity-bar-active")
                indicator = self._token("--activity-bar-indicator")
                self.evidence(
                    f"bar {bar.hex()} beside sidebar {sidebar.hex()}; inactive "
                    f"{contrast(inactive, bar):.2f}:1, active {contrast(active, bar):.2f}:1, "
                    f"indicator {contrast(indicator, bar):.2f}:1"
                )
                problems = activity_bar_problems(bar, sidebar, inactive, active, indicator)
                assert not problems, problems

    def test_40_switch_states(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}.switch-states",
                f"{theme}: switch knobs reach 3:1 on their tracks; on shows a check (#5853 R-146)",
                expect=f"the app in {theme}, Settings open; on switches show a check mark "
                "in the knob, off switches a plain knob",
            ):
                self.set_theme(theme)
                self.open_settings_category("general")
                off_knob = self._token("--toggle-off-thumb")
                off_track = self._token("--toggle-off-track")
                on_knob = self._token("--text-on-accent")
                on_track = self._token("--accent-color")
                self.evidence(
                    f"off knob {off_knob.hex()} on {off_track.hex()} "
                    f"{contrast(off_knob, off_track):.2f}:1; on knob {on_knob.hex()} on "
                    f"{on_track.hex()} {contrast(on_knob, on_track):.2f}:1"
                )
                problems = toggle_problems(off_knob, off_track, on_knob, on_track)
                assert not problems, problems
