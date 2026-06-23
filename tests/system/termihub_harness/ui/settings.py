"""Settings-editor helpers (issue #831).

``SettingsUi`` opens the Settings tab, navigates its category nav, and toggles
experimental features. ``enable_experimental_features`` returns to the
Connections view afterward, so suites also mix in
:class:`~termihub_harness.ui.SidebarUi`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..bridge import BridgeError
from .base import HarnessMixin


class SettingsUi(HarnessMixin):
    """Open the Settings tab, navigate categories, and toggle experimental flags."""

    if TYPE_CHECKING:  # borrowed from SidebarUi, with which suites combine this
        def switch_to_connections_sidebar(self) -> None: ...

    def open_settings_tab(self) -> None:
        """Open the Settings editor tab from the activity-bar gear menu."""
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists("settings-menu-open"), what="the settings menu"
        )
        self.driver.click("settings-menu-open")

    def enable_experimental_features(self) -> None:
        """Turn on experimental features (reveals the Tunnels/Services views)."""
        if self._experimental_enabled():
            return
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists("settings-experimental-features"),
            what="the experimental-features toggle",
        )
        self.driver.click("settings-experimental-features")
        self.wait(self._experimental_enabled, what="experimental features to enable")
        self.switch_to_connections_sidebar()

    def _experimental_enabled(self) -> bool:
        # The setting is absent from the store until first set, so a missing path
        # (BridgeError) means "off".
        try:
            return bool(self.driver.get_state("settings.experimentalFeaturesEnabled"))
        except BridgeError:
            return False

    def open_settings_category(self, category: str) -> None:
        """Open Settings and select a category nav item (e.g. ``external-files``).

        Only the active category's fields are mounted, so a setting like
        ``toggle-power-monitoring`` (under *external-files*) must be navigated to.
        """
        self.open_settings_tab()
        nav = f"settings-nav-{category}"
        self.wait(lambda: self.driver.exists(nav), what=f"the {category} settings nav")
        self.driver.click(nav)
