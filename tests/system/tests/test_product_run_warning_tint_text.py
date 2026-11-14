"""Product run: body copy and links on a warning tint reach AA (#5744).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Follow-up to #5740: the reconnect strip and view-mode
banner bodies, the plugin native-code callout description, the workspace
override notice, the update-agent warning hint and the tunnel reachability
action painted ``--text-secondary`` / ``--text-link`` on a 12% warning tint,
which measures 3.4-4.49:1 depending on the theme. Body copy now reads
``--text-primary``; the link reads ``--text-link-on-tint`` (``--text-link``
mixed 60% with ``--text-primary``, underlined). This grade reads, per built-in
theme, what the WebView resolved for those tokens and composites the warning
tint over the surfaces it sits on.
"""

from __future__ import annotations

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest
from termihub_harness.colors import Rgba, composite, contrast
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

AA_TEXT = 4.5
#: The warning tint strength the callouts, notices and strips use.
WARNING_ALPHA = 0.12
#: ``--text-link-on-tint`` = ``color-mix(in srgb, var(--text-link) 60%, var(--text-primary))``.
#: A custom property's computed value keeps the ``color-mix`` unresolved, so the
#: grade mixes the two resolved tokens itself.
LINK_WEIGHT = 0.6
#: The surfaces the tinted callouts sit on (the terminal strips sit on --terminal-bg).
SURFACES = (
    "--bg-primary",
    "--bg-secondary",
    "--sidebar-bg",
    "--bg-dropdown",
    "--bg-tertiary",
    "--terminal-bg",
)


class TestProductRunWarningTintText(ProductRunUi, ThemeUi, SettingsUi, SidebarUi, SystemTest):
    phase = "Body copy and links on warning tints"
    request_timeout = 90.0

    def test_10_warning_tint_text_meets_aa(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}.warning-tint-text",
                f"{theme}: body copy and links on warning tints reach 4.5:1 (#5744)",
                expect=f"the app in {theme}; warning callouts and their links read clearly",
            ):
                self.set_theme(theme)
                warning = self.root_color("--color-warning")
                primary = self.root_color("--text-primary")
                link = self.root_color("--text-link")
                link_on_tint = composite(Rgba(link.r, link.g, link.b, LINK_WEIGHT), primary)
                failures: list[str] = []
                for surface in SURFACES:
                    base = self.root_color(surface)
                    tint = composite(Rgba(warning.r, warning.g, warning.b, WARNING_ALPHA), base)
                    for name, fg in (
                        ("--text-primary", primary),
                        ("--text-link-on-tint", link_on_tint),
                    ):
                        ratio = contrast(fg, tint)
                        self.evidence(
                            f"{name} {fg.hex()} on warning tint over {surface} "
                            f"{base.hex()} = {ratio:.2f}:1"
                        )
                        if ratio < AA_TEXT:
                            failures.append(f"{name} over {surface} {ratio:.2f}:1")
                assert not failures, f"{theme}: below AA: {failures}"
