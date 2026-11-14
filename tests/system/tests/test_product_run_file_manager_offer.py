"""Product run: the one-time file-manager offer is a toast (#5753).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Maintainer decision 2026-11-13: the "Open in termiHub"
file-manager offer is shown **once**, as a toast with *Install* and *Not now*
(closing it counts as *Not now*); it stays available in Settings › File manager
integration (#5616) and never shows in a session with the crash banner. The
docked bottom bar it replaced (#5638) is gone.

The grade:

1. A fresh, crash-free profile shows the offer as a toast with Install and
   Not now (no docked bar), and records at once that it was shown.
2. *Not now* closes it; after a relaunch it does not come back.
3. A profile that has not had the offer yet but starts with a crash report shows
   the crash banner and no offer, not even after the banner is closed.

Nothing is installed: the grade never presses *Install*, so the user's real
file-manager registration is never touched.
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import CrashReportUi, SettingsUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.diagnostics import CRASH_NOTICE, CRASH_NOTICE_DISMISS, crash_report_name

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

OFFER = "file-manager-offer"
OFFER_INSTALL = "file-manager-offer-install"
OFFER_NOT_NOW = "file-manager-offer-not-now"
#: The docked bar the toast replaced (#5638); it must never render again.
OLD_BANNER = "shell-integration-banner"
OFFER_TITLE = "Add “Open in termiHub” to your file manager?"
#: How long the offer must stay away where it must not show.
QUIET_SECONDS = 6.0


class TestProductRunFileManagerOffer(ProductRunUi, CrashReportUi, SettingsUi, SystemTest):
    phase = "File-manager offer"

    def _offer_shown_flag(self) -> object:
        """``shellIntegration.firstLaunchBannerDismissed`` in ``settings.json``."""
        si = self.persisted_settings().get("shellIntegration") or {}
        return si.get("firstLaunchBannerDismissed") if isinstance(si, dict) else None

    def _assert_no_offer_for(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert not self.driver.exists(OFFER), "the file-manager offer toast showed"
            assert not self.driver.exists(OLD_BANNER), "the docked file-manager bar is back"
            time.sleep(0.25)

    def _forget_offer_and_seed_crash(self) -> None:
        """While the app is down: offer not shown yet, and a crash report waiting."""
        si = self.persisted_settings().get("shellIntegration") or {}
        self.write_settings_file(shellIntegration={**si, "firstLaunchBannerDismissed": False})
        self.seed_local_crash_report(
            crash_report_name(),
            "termiHub product run: SEEDED crash report (not a real crash).\n"
            "It exists only to check the file-manager offer stays away (#5753).\n",
        )

    def test_10_offer_is_a_toast(self):
        with self.step(
            "fm-offer.toast",
            "A crash-free first launch offers 'Open in termiHub' once, as a toast (#5753)",
            expect="the main window with one toast at the bottom right: 'Add “Open in termiHub” "
            "to your file manager?', a Not now and an Install button; no docked bar at the "
            "bottom of the window",
        ):
            self.wait(lambda: self.driver.exists(OFFER), what="the file-manager offer toast")
            text = self.driver.get_text(OFFER)
            self.evidence(f"toast text: {text!r}")
            assert OFFER_TITLE in text, text
            assert "Settings › File manager integration" in text, text
            assert self.driver.get_text(OFFER_INSTALL).strip() == "Install"
            assert self.driver.get_text(OFFER_NOT_NOW).strip() == "Not now"
            assert not self.driver.exists(OLD_BANNER), "the docked file-manager bar still shows"
            assert not self.driver.exists(CRASH_NOTICE), "a crash banner shows beside the offer"
            self.wait(
                lambda: self._offer_shown_flag() is True,
                what="the offer recorded as shown in settings.json",
            )

    def test_20_not_now_and_never_again(self):
        with self.step(
            "fm-offer.not-now",
            "Not now closes the offer, and it does not come back after a relaunch (#5753)",
            expect="the relaunched main window without the file-manager offer toast",
        ):
            self.require("fm-offer.toast")
            self.driver.click(OFFER_NOT_NOW)
            self.wait(lambda: not self.driver.exists(OFFER), what="the offer toast to close")
            self.restart_app()
            self._assert_no_offer_for(QUIET_SECONDS)
            self.evidence(f"no offer within {QUIET_SECONDS:.0f}s of the relaunch")

    def test_30_never_with_crash_banner(self):
        with self.step(
            "fm-offer.crash-session",
            "The offer never shows in a session with the crash banner, even once it is closed "
            "(#5753)",
            expect="the main window after the crash banner was closed, with no file-manager "
            "offer toast",
        ):
            self.require("fm-offer.toast")
            self.restart_app(self._forget_offer_and_seed_crash)
            self.wait_notice_visible(CRASH_NOTICE)
            self._assert_no_offer_for(2.0)
            self.driver.click(CRASH_NOTICE_DISMISS)
            self.wait(lambda: not self.driver.exists(CRASH_NOTICE), what="the banner to close")
            self._assert_no_offer_for(QUIET_SECONDS)
            # It was not shown, so a later crash-free launch still offers it.
            assert self._offer_shown_flag() is False, "the offer was recorded as shown"
            self.evidence("no offer in the crash session; still pending for a later launch")
