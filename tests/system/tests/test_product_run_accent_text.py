"""Product run: accent foregrounds read the text tokens, not the fill (#5727).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Follow-up to #5702: about 34 rules painted text and icons
with ``--accent-color``, the button *fill* token, which Solarized Dark darkens
for white button labels (~2.5-3.3:1 on its own backgrounds). They now read
``--text-link`` / ``--text-accent``. This grade reads, per built-in theme, what
the WebView resolved for those tokens against the surfaces they sit on.
"""

from __future__ import annotations

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest
from termihub_harness.colors import contrast
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

AA_TEXT = 4.5
#: The text tokens the accent foregrounds moved to.
TEXT_TOKENS = ("--text-accent", "--text-link")
#: The surfaces those foregrounds sit on (#5399 tunes the tokens for these).
SURFACES = ("--bg-primary", "--bg-secondary", "--sidebar-bg", "--bg-dropdown")


class TestProductRunAccentText(ProductRunUi, ThemeUi, SettingsUi, SidebarUi, SystemTest):
    phase = "Accent text tokens"
    request_timeout = 90.0

    def test_10_accent_text_tokens_meet_aa(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}.accent-text",
                f"{theme}: accent links and labels reach 4.5:1 on every surface (#5727)",
                expect=f"the app in {theme}; blue links / accent labels read clearly",
            ):
                self.set_theme(theme)
                failures: list[str] = []
                for token in TEXT_TOKENS:
                    fg = self.root_color(token)
                    for surface in SURFACES:
                        bg = self.root_color(surface)
                        ratio = contrast(fg, bg)
                        self.evidence(f"{token} {fg.hex()} on {surface} {bg.hex()} = {ratio:.2f}:1")
                        if ratio < AA_TEXT:
                            failures.append(f"{token} on {surface} {ratio:.2f}:1")
                assert not failures, f"{theme}: below AA: {failures}"
