"""Product run: status labels on a status tint read the primary text (#5740).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Follow-up to #5727: chips, badges and banners (agent
version badge, active log-level filters, Open Connections badges, plugin
status, settings notices, file-editor banners, the reconnect strip) painted a
status colour as text on an 18% tint of the same colour, which measures down to
~3:1 in Light and Solarized (the fixed notice amber 1.6:1). The labels now read
``--text-primary``; the tint keeps the status cue. This grade reads, per
built-in theme, what the WebView resolved for those tokens and composites each
status tint over the surfaces it sits on.
"""

from __future__ import annotations

import pytest

from termihub_harness import SettingsUi, SidebarUi, SystemTest
from termihub_harness.colors import Rgba, composite, contrast
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

AA_TEXT = 4.5
#: The status colours painted as chip / badge / banner tints.
STATUS_TOKENS = (
    "--color-success",
    "--color-warning",
    "--color-error",
    "--color-info",
    "--color-notice",
    "--state-connected",
)
#: The tint strengths the stylesheets use (10%-18%); 18% is the darkest.
ALPHAS = (0.1, 0.12, 0.15, 0.18)
#: The surfaces a transparent tint sits on.
SURFACES = ("--bg-primary", "--bg-secondary", "--sidebar-bg", "--bg-dropdown", "--bg-tertiary")


class TestProductRunStatusTint(ProductRunUi, ThemeUi, SettingsUi, SidebarUi, SystemTest):
    phase = "Status labels on status tints"
    request_timeout = 90.0

    def test_10_status_tint_labels_meet_aa(self):
        for theme in BUILTIN_THEMES:
            with self.step(
                f"themes.{theme}.status-tint",
                f"{theme}: labels on success/warning/error/info tints reach 4.5:1 (#5740)",
                expect=f"the app in {theme}; tinted status chips read clearly",
            ):
                self.set_theme(theme)
                label = self.root_color("--text-primary")
                failures: list[str] = []
                for token in STATUS_TOKENS:
                    status = self.root_color(token)
                    for surface in SURFACES:
                        base = self.root_color(surface)
                        worst = min(
                            contrast(label, composite(Rgba(status.r, status.g, status.b, a), base))
                            for a in ALPHAS
                        )
                        self.evidence(
                            f"--text-primary {label.hex()} on {token} tint over {surface} "
                            f"{base.hex()} >= {worst:.2f}:1"
                        )
                        if worst < AA_TEXT:
                            failures.append(f"{token} over {surface} {worst:.2f}:1")
                assert not failures, f"{theme}: below AA: {failures}"
