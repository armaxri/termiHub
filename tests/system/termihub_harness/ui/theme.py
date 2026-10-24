"""Theme switching and computed-colour reads for the theme/layout grades (#4930).

The grades that replaced the look-and-feel guided checks read what the WebView
actually resolved — computed styles, the terminal's measured paint, sampled
chart pixels — and judge them with :mod:`termihub_harness.colors`. This mixin
holds the shared moves: switch the theme and wait for it to land, read a
computed colour, create/delete a custom theme, and sample a ``<canvas>``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Iterable, Optional

from ..colors import Rgba, parse_color
from .base import UNSAVED_DISCARD, HarnessMixin
from .settings import SETTINGS_REGION

#: The built-in themes (Settings > Appearance > Theme values).
BUILTIN_THEMES = ("dark", "light", "solarized-dark", "solarized-light")
LIGHT_THEMES = ("light", "solarized-light")

THEME_SELECT = "appearance-theme-select"


class ThemeUi(HarnessMixin):
    """Switch themes and read the colours the WebView resolved."""

    if TYPE_CHECKING:

        def open_settings_category(self, category: str) -> None: ...
        def projection_region_cache(self, region: str) -> dict[str, Any]: ...

    def current_theme(self) -> Optional[str]:
        return self.projection_region_cache(SETTINGS_REGION).get("theme")

    def set_theme(self, theme: str) -> None:
        """Select ``theme`` in Settings > Appearance and wait until it applies.

        Waits for the persisted setting *and* for ``:root``'s ``--bg-primary`` to
        settle, so a grade never reads the previous theme's tokens.
        """
        self.open_settings_category("appearance")
        self.driver.select(THEME_SELECT, theme)
        self.wait(lambda: self.current_theme() == theme, what=f"the {theme} theme setting")
        self.wait_root_settled()

    def wait_root_settled(self) -> str:
        """Wait until ``--bg-primary`` reads the same twice; return it."""
        seen: list[str] = []

        def stable() -> Optional[str]:
            value = self.driver.get_computed_style("--bg-primary")
            seen.append(value)
            return value if len(seen) >= 2 and seen[-1] == seen[-2] and value else None

        return self.wait(stable, what="the theme tokens to settle")

    def root_color(self, name: str) -> Rgba:
        """A theme token off ``:root`` (e.g. ``--terminal-bg``), parsed."""
        return parse_color(self.driver.get_computed_style(name))

    def style_color(self, prop: str, test_id: str) -> Rgba:
        """A computed colour property (``color``, ``background-color``, …) of an element."""
        return parse_color(self.driver.get_computed_style(prop, test_id))

    def opaque_background(self, test_id: str, fallback: Rgba) -> Rgba:
        """An element's background, or ``fallback`` when it paints none (transparent)."""
        color = self.style_color("background-color", test_id)
        return color if color.a > 0.99 else fallback

    # ── Custom themes ────────────────────────────────────────────────────────
    def open_new_theme_editor(self) -> None:
        """Open Settings > Appearance > New Theme (based on the active built-in)."""
        self.open_settings_category("appearance")
        self.driver.click("appearance-theme-new")
        self.wait(lambda: self.driver.exists("theme-editor-dialog"), what="the theme editor")

    def set_theme_token(self, token: str, hex_value: str) -> None:
        """Type ``hex_value`` into the editor's hex field for ``token`` (live preview)."""
        self.driver.type(f"theme-editor-hex-{token}", hex_value)

    def save_theme_editor(self) -> str:
        """Save the open theme editor; wait until the new custom theme is active."""
        before = self.current_theme()
        self.driver.click("theme-editor-save")
        self.wait(
            lambda: not self.driver.exists("theme-editor-dialog")
            and self.current_theme() not in (None, before, *BUILTIN_THEMES, "system"),
            what="the custom theme to be saved and selected",
        )
        self.wait_root_settled()
        return self.current_theme() or ""

    def cancel_theme_editor(self) -> None:
        """Cancel the editor, discarding edits (answers the unsaved-changes prompt)."""
        self.driver.click("theme-editor-cancel")

        def closed() -> bool:
            if self.driver.exists(UNSAVED_DISCARD):
                self.driver.click(UNSAVED_DISCARD)
            return not self.driver.exists("theme-editor-dialog")

        self.wait(closed, what="the theme editor to close")
        self.wait_root_settled()

    def delete_active_custom_theme(self) -> None:
        """Delete the selected custom theme (the app falls back to Dark)."""
        self.open_settings_category("appearance")
        self.driver.click("appearance-theme-delete")
        self.wait(lambda: self.current_theme() == "dark", what="the custom theme deleted")
        self.wait_root_settled()

    # ── Canvas ───────────────────────────────────────────────────────────────
    def canvas_pixels(self, test_id: str, *, step_x: int = 6, step_y: int = 2) -> list[Rgba]:
        """Opaque-ish pixels on a grid over the ``<canvas>`` tagged ``test_id``.

        Rows are sampled densely (``step_y``) so 1-px horizontal lines (grid,
        a flat latency trace) are never stepped over. Transparent background
        pixels (alpha < 0.75) are dropped.
        """
        size = self.driver.sample_canvas(test_id)
        width, height = int(size["width"]), int(size["height"])
        if width <= 0 or height <= 0:
            return []
        points = [(x, y) for y in range(0, height, step_y) for x in range(0, width, step_x)]
        pixels: list[Rgba] = []
        for chunk in _chunks(points, 4000):
            sampled = self.driver.sample_canvas(test_id, chunk)["pixels"]
            pixels.extend(Rgba(r, g, b, a / 255) for r, g, b, a in sampled if a >= 192)
        return pixels


def near(pixels: Iterable[Rgba], color: Rgba, tolerance: float = 24.0) -> int:
    """How many ``pixels`` match ``color`` within ``tolerance`` per channel."""
    return sum(
        1
        for p in pixels
        if abs(p.r - color.r) <= tolerance
        and abs(p.g - color.g) <= tolerance
        and abs(p.b - color.b) <= tolerance
    )


def _chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]
