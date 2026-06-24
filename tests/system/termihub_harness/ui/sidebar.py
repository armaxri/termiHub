"""Activity-bar sidebar *view* switching (issue #831).

``SidebarUi`` switches which sidebar view is shown (connections vs. file
browser) from the activity bar. It is a shared dependency of
:class:`~termihub_harness.ui.SftpUi` (needs the Files view) and
:class:`~termihub_harness.ui.SettingsUi` (returns to the Connections view), and
several connection/monitoring suites drive it directly.

This is distinct from ``LayoutUi.set_sidebar_visible``, which toggles whether the
sidebar is shown at all rather than which view it displays.
"""

from __future__ import annotations

from ..bridge import BridgeError
from .base import HarnessMixin


class SidebarUi(HarnessMixin):
    """Switch the activity-bar sidebar between its views (idempotent)."""

    def _ensure_sidebar(self, view: str, test_id: str) -> None:
        """Show the given sidebar ``view`` (idempotent).

        Clicking an already-active activity-bar icon *toggles the sidebar
        closed*, so only click when ``view`` isn't already the visible one.
        """
        try:
            showing = self.driver.get_state("sidebarView") == view and not self.driver.get_state(
                "sidebarCollapsed"
            )
        except BridgeError:
            showing = False
        if not showing:
            self.driver.click(test_id)

    def switch_to_files_sidebar(self) -> None:
        """Open the SFTP file-browser sidebar from the activity bar."""
        self._ensure_sidebar("files", "activity-bar-file-browser")

    def switch_to_connections_sidebar(self) -> None:
        """Return to the connections sidebar from the activity bar."""
        self._ensure_sidebar("connections", "activity-bar-connections")
